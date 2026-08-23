/**
 * WHERE IS THE PLAYER — and how much should anyone believe it.
 *
 * 🔴 EVERY DISTANCE THIS APP SHOWS RESTS ON THIS, and it is an inference. Trade routes, hauling
 * routes and the Verse Finder all order things by "how far from you", and each is only as
 * trustworthy as the guess underneath. Sub was explicit that the confidence has to travel with the
 * number: "we'll need to have that on any app that's going to be giving distance."
 *
 * -- What the log actually offers, measured on a real 16 MB session ---------------------------
 *
 * Sub's framing: "All we could do is find every point at which they can interact with something
 * that allows to pinpoint their location." That is the whole design — there is no position feed,
 * so this is an inventory of the moments the game happens to say where you are.
 *
 *   TIER          signal                                              fires
 *   place         `requested inventory for Location[X]`               when you open inventory (12)
 *   place         ASOP terminal / ship list provider                  when you retrieve a ship
 *   place         freight elevator platform                           when you move cargo (184)
 *   place         `Quantum Drive Arrived` + the route's destination   on every completed QT (4)
 *   body          `planet cells:` terrain report                      EVERY 10 MIN, near a planet
 *   system        `Projected Start Location is X`                     on every route calculation (21)
 *
 * 🔑 THE TERRAIN REPORT IS THE ONLY ONE THAT FIRES ON ITS OWN. Every other signal needs the player
 * to do something, so without it a session that is just flying goes dark indefinitely. That is
 * what makes it worth having despite being the coarsest: it is the only heartbeat.
 * ⚠️ It carries NO coordinates — measured, the payload has zero fractional numbers. It names the
 * body whose terrain is streaming (`OOC_Stanton_2b_Daymar`) and nothing more. Anything expecting a
 * position from it is expecting the wrong thing.
 *
 * -- Why this is not simply "freshest wins" ---------------------------------------------------
 *
 * 🔴 THE HEARTBEAT WOULD MASK EVERY PRECISE FIX. The terrain report fires every ten minutes
 * unconditionally, so on a planet-side outpost it is almost always the newest thing in the log —
 * and a naive freshest-wins would replace "you are at Shubin SAL-2" with "you are somewhere near
 * Lyria" within ten minutes of arriving, forever. Precision would decay on a timer while the
 * player stood still.
 *
 * So: **the most PRECISE signal wins while it is still plausible**, and a coarser one only takes
 * over when the precise one has aged out or is contradicted. A newer coarse reading that
 * CONTAINS the older precise one is not a contradiction — being near Lyria is exactly what being
 * at a Lyria outpost looks like — so it refreshes the fix rather than replacing it.
 *
 * -- 🔴 A TIER THAT WAS EVALUATED AND REJECTED: SHOP TERMINALS (2026-08-23) --------------------
 *
 * Sub asked whether the app can tell where a player is when they buy something at a terminal:
 * "now that I've been going to these terminals to buy things, I want you to see if we can
 * determine where a person is when they interact with these terminals." The proposal was a fourth
 * `place` source — learn `shopName -> place` where a shop line co-occurs with a location line,
 * persist it, and let later visits become an immediate fix, since `shopName` survives sessions
 * where the runtime `shopId` does not.
 *
 * 🔴 THE FIX IS REAL AND THE TIER IS WORTHLESS, AND THOSE ARE TWO DIFFERENT SENTENCES. A terminal
 * does place you, to the station, reliably. It buys nothing because **a terminal is inside a
 * station and you cannot get inside one without the app having already placed you** — docking,
 * spawning and walking in all fire an inventory, an ASOP or a freight lift first. Measured over
 * Sub's entire log history (533 logs, 74 sessions with shopping, 727 shop-terminal lines,
 * 382.6 h of wall-clock):
 *
 *   - **0 of 727** shop lines were the first thing to place him in that session. Not rare — never.
 *     A persisted map only ever pays at such a "cold open"; anywhere else it repeats a fix we hold.
 *   - Counting a shop line as a place signal moves freshness coverage **57.3% -> 57.4%**: a gain
 *     of **37 minutes across 382.6 hours**. Against the more generous baseline it is 11 minutes.
 *   - The window cannot be chosen safely. Pairing within 60 s learns **7** shop names and nothing
 *     wrong; within 300 s it learns 27 and **5 are already ambiguous**. There is no window where
 *     the map is both useful and safe.
 *
 * 🔑 AND THE AMBIGUITY IS WORSE THAN "SOME NAMES ARE GENERIC". `SCShop_AdminOffice_Nyx_Social
 * Station` — a name that carries a place token — sits at three different Keeger asteroid bases,
 * two of them in ONE session of Sub's. What such a name states is the SYSTEM and the station
 * CLASS, never the station. `shopId` really is site-unique (102 of 102 within a session) but it
 * is re-minted per session, so it can never be persisted. The stable identifier is ambiguous and
 * the unambiguous one is not stable, which is the whole reason this does not work.
 *
 * 🔑 Re-ask it after a patch with **`npm run measure:terminalorigin`**. It exits non-zero the
 * moment a cold open appears, which is exactly the observation that would reopen the design.
 * ⚠️ Do NOT read "the fix was fresh whenever he shopped" as the finding — that is true and beside
 * the point, since the widget is read at arbitrary moments. Coverage is the measure, and it moved
 * by a rounding error.
 */

export type OriginTier = "place" | "body" | "system" | "unknown";

export interface OriginSignal {
  tier: OriginTier;
  /** Whatever the log named — a location token, a body, a system. */
  id: string;
  /** Human-readable, for the UI. */
  label: string;
  /** Epoch ms. */
  at: number;
  /** Which log signal produced this, for the tooltip's "where this came from". */
  source: string;
}

export interface OriginVerdict {
  tier: OriginTier;
  /** The winning signal's own id — the starmap place/body/system token, NOT the display label.
   *
   *  🔑 Added by verse2 because without it a verdict cannot be USED, only shown: computing a
   *  distance needs the id that `locations-xyz` is keyed by, and re-deriving one from `label`
   *  would be exactly the name-matching this module exists to avoid. Null only for "unknown". */
  id: string | null;
  label: string;
  /** Epoch ms of the reading, or null when nothing is known. */
  at: number | null;
  /** How old, in minutes. Null when unknown. */
  ageMin: number | null;
  /** Where the estimate came from, in plain language. */
  from: string;
  /** The concrete thing the player can do to improve it. Sub's requirement: the hover must say
   *  "what they need to do to sync it", not merely that the estimate is uncertain. */
  howToImprove: string;
  /** True when the reading is old enough that it should be read as a last-known rather than a
   *  current position. */
  stale: boolean;
}

/**
 * How long each tier stays believable.
 *
 * 🔑 These are not arbitrary — each is derived from how the underlying signal behaves:
 *
 * - **place, 45 min.** Nothing fires when you LEAVE a station, so a place fix can only ever decay
 *   by assumption. 45 minutes is long enough to cover a docked session and short enough that an
 *   abandoned one stops being asserted as current.
 * - **body, 25 min.** The terrain report fires every 10 minutes while you are near a body, so
 *   TWO missed reports means you are no longer near it. This is the one window with a real
 *   mechanism behind it rather than a judgement call.
 * - **system, never.** You cannot leave a system without a jump, and a jump writes more
 *   `Projected Start Location` lines. `src/location.ts`'s SystemWatcher already reasons exactly
 *   this way about the same signal, and this agrees with it on purpose.
 */
export const TRUST_MIN: Record<Exclude<OriginTier, "unknown">, number> = {
  place: 45,
  body: 25,
  system: Number.POSITIVE_INFINITY,
};

const RANK: Record<OriginTier, number> = { place: 3, body: 2, system: 1, unknown: 0 };

export interface OriginDeps {
  /** Body a place sits on, lowercased, or null. Used to tell "contains" from "contradicts". */
  bodyOfPlace(placeId: string): string | null;
  /** System a place or body sits in, lowercased, or null. */
  systemOf(id: string): string | null;
  now?: () => number;
}

/**
 * Pick the best available reading.
 *
 * 🔴 IT RETURNS "unknown" RATHER THAN A DEFAULT. This codebase already holds that line — "an
 * ambiguous match resolves to NOTHING, because putting the player at the wrong outpost is worse
 * than not knowing" — and a distance computed from an invented origin is exactly that mistake
 * wearing a number.
 */
export function resolveOrigin(signals: readonly OriginSignal[], deps: OriginDeps): OriginVerdict {
  const now = deps.now ? deps.now() : Date.now();
  const age = (s: OriginSignal): number => (now - s.at) / 60000;

  // Newest per tier. A tier's older readings can never beat its own newest.
  const best = new Map<OriginTier, OriginSignal>();
  for (const s of signals) {
    if (s.tier === "unknown") continue;
    const cur = best.get(s.tier);
    if (!cur || s.at > cur.at) best.set(s.tier, s);
  }

  // 🔴 CONTRADICTION CHECK. A newer COARSER reading that does not contain the finer one proves the
  // player moved — the fine fix is not merely old, it is wrong, and must be dropped rather than
  // shown with a caveat. Containment is the discriminator: "near Lyria" is what standing at a
  // Lyria outpost looks like, so that is a refresh; "near Daymar" is not.
  const place = best.get("place"), body = best.get("body"), system = best.get("system");
  if (place && body && body.at > place.at) {
    const pb = deps.bodyOfPlace(place.id);
    if (pb && pb !== body.id.toLowerCase()) best.delete("place");
  }
  const kept = best.get("place");
  if (kept && system && system.at > kept.at) {
    const ps = deps.systemOf(kept.id);
    if (ps && ps !== system.id.toLowerCase()) best.delete("place");
  }
  if (body && system && system.at > body.at) {
    const bs = deps.systemOf(body.id);
    if (bs && bs !== system.id.toLowerCase()) best.delete("body");
  }

  // Most precise surviving reading that is still inside its own trust window.
  const order: Exclude<OriginTier, "unknown">[] = ["place", "body", "system"];
  order.sort((a, b) => RANK[b] - RANK[a]);
  for (const tier of order) {
    const s = best.get(tier);
    if (!s) continue;
    const a = age(s);
    if (a > TRUST_MIN[tier]) continue;
    return {
      tier,
      id: s.id,
      label: s.label,
      at: s.at,
      ageMin: a,
      from: s.source,
      howToImprove: improve(tier),
      // 🔑 "stale" is a softer claim than aged-out: it means believe it less, not stop believing
      // it. Half the trust window is where a reading stops being current and starts being recent.
      stale: a > TRUST_MIN[tier] / 2,
    };
  }
  // Nothing inside its window — fall back to the freshest expired reading rather than nothing,
  // but say plainly that it is a last-known.
  const expired = [...best.values()].sort((a, b) => b.at - a.at)[0];
  if (expired) {
    return {
      tier: expired.tier,
      id: expired.id,
      label: expired.label,
      at: expired.at,
      ageMin: age(expired),
      from: expired.source,
      howToImprove: improve(expired.tier),
      stale: true,
    };
  }
  return {
    tier: "unknown",
    id: null,
    label: "Unknown",
    at: null,
    ageMin: null,
    from: "nothing in this session has said where you are",
    howToImprove: improve("unknown"),
    stale: true,
  };
}

/**
 * What the player can actually DO. Sub's requirement for the hover: "we can explain where they
 * need to go and what they need to do to sync it."
 *
 * ⚠️ The debug-overlay Sync is mentioned LAST and only on the coarse tiers, deliberately. Sub:
 * "it's really a lot of work to have the player have to do that... I'd rather not have much rely
 * on that." It is an upgrade for someone who wants one, never the instruction.
 */
function improve(tier: OriginTier): string {
  switch (tier) {
    case "place":
      return "This is as good as it gets from the log. It refreshes whenever you open your inventory, use an ASOP terminal, move cargo, or finish a quantum jump.";
    case "body":
      return "The game reports which body you are near about every ten minutes. Open your inventory, use a terminal, or finish a quantum jump to pin it to an exact place.";
    case "system":
      return "Only your system is known. Fly near a planet, or open your inventory at any station, and the estimate will sharpen.";
    default:
      return "Nothing in this session has placed you yet. Opening your inventory, using a terminal, or finishing a quantum jump will.";
  }
}

/**
 * One-line summary for a compact UI. Kept here so every surface words it identically.
 *
 * 🔴 THE AGE UNIT IS SPELLED OUT — "19 min ago", never "19m ago". This looks like fussiness and is
 * not. Sub read "New Babbage 4M away" as a distance on 2026-08-22; the `4m` was this age, sitting
 * a few pixels from a place name in a widget whose other numbers ARE distances (Mm, Gm). Three
 * different quantities in the same shape merged into one wrong reading. `m` is genuinely ambiguous
 * here — metres, megametres and minutes are all live in this UI — so it may not appear alone.
 */
export function originSummary(v: OriginVerdict): string {
  if (v.tier === "unknown") return "Location unknown";
  const age = v.ageMin === null ? "" :
    v.ageMin < 1 ? " · just now" :
    v.ageMin < 60 ? " · " + Math.round(v.ageMin) + " min ago" :
    " · " + Math.round(v.ageMin / 60) + "h ago";
  const what = v.tier === "place" ? v.label
    : v.tier === "body" ? "near " + v.label
    : "somewhere in " + v.label;
  return what + age;
}
