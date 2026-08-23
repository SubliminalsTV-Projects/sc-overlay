/**
 * WHERE IS THE PLAYER — the one owner. Every source feeds this; every widget asks it.
 *
 * The three files split like this, and the split is the point:
 *
 *   player-origin.ts    GRADES a set of readings. Pure arithmetic — trust windows, contradiction,
 *                       which tier wins. Knows nothing about logs.
 *   origin-signals.ts   TURNS raw readings into graded-able signals. Knows the starmap namespace.
 *   player-location.ts  OWNS the state. Every log line is fed here once; this is what remembers
 *                       what the session has seen and hands the other two their inputs.
 *
 * Before this file existed there was no owner. `PlaceWatcher` and `SystemWatcher` were two loose
 * objects in `overlay-server.ts`, the terminal fixes lived inside `HaulingTracker`, the numeric-id
 * binding lived in a helper only the hauling widget called, and `collectOriginSignals` re-assembled
 * the pieces per request. Four places knowing a bit of "where is the player" is how the two bugs
 * below survived: nobody owned the question, so nobody noticed the answer was missing.
 *
 * -- 🔴 THE TWO DARK GAPS THIS CLOSES, both measured over 533 logs / 1,213.9 h -------------------
 *
 * **1. THE STARTUP SEED NEVER FED THE WATCHERS.** `seedTrackerFromLog()` replays the whole live
 * log into the mission tracker, the party, hauling, chat and trade — and called neither
 * `place.push()` nor `sysWatch.push()`. So on every launch the body and system tiers began EMPTY
 * and stayed empty until the game happened to write a fresh terrain report (up to ten minutes) or
 * the player touched a quantum drive. Launching the app while already playing is the common case,
 * which is exactly when this bit.
 *
 *   - **236 of 533 sessions (301.7 h, 24.9%) contain no named location line at all** — those are
 *     the sessions where the widget can only say "Location unknown".
 *   - **105 of those 236, worth 199.1 h, contain a terrain report or a quantum route** and were
 *     dark purely because the seed threw them away.
 *   - Freshness coverage across the whole corpus: **35.8% -> 84.3%**, +48.5 points, 588.7 hours.
 *
 * 🔑 THE SEED MUST STAMP THE LOG'S OWN TIME, NOT `Date.now()`. Both watchers default `now` to the
 * wall clock, which is right for a live tail and catastrophic for a replay — a terrain report from
 * three hours ago would arrive looking brand new and outrank a fix that really is current.
 * 🔑 THE LIVE LOG ONLY, NEVER THE ROTATED ONE. The game writes a fresh `Game.log` per launch, so
 * one file is exactly one session; everything in it happened to the player who is playing now.
 * A rotated backup is a previous session and could seed a system the player has since left.
 *
 * **2. THE NUMERIC LOCATION ID NEVER REACHED THE LADDER.** The game states where you are in two
 * shapes — a readable token (`Location[Stanton3_Area18]`, from a location inventory) and a bare
 * number (`at location [3490636373]`, from the ASOP, an item move, or the freight kiosk). The
 * number fires far more often, and `origin-signals.ts` was handed it RAW: `matchLocationToken`
 * cannot resolve a number, so every one of them was silently dropped. Measured, the numeric signal
 * is worth **+11.2 points of PLACE-tier freshness (135.8 h)** — and place is the only tier a
 * per-station distance can come from, so this is precision, not just coverage.
 *
 * 🔑 THE NUMBER NAMES NOTHING BY ITSELF, so it has to be bound to a token seen at the same place.
 * `haulingWhereAmI()` already did that — but it binds from a LAST-SEEN pair sampled whenever the
 * hauling widget happens to ask, so it sees almost nothing: on Sub's real machine, after months,
 * `config.haulingPlaceIds` held **one** entry. Binding on the PARSE instead sees every pairing.
 *
 * 🔑 AND THE NUMERIC ID IS GENUINELY STABLE ACROSS SESSIONS, which is why it may be persisted —
 * measured, not assumed: **89 ids appear in more than one session (one of them in 86 sessions) and
 * not one ever names two different places.** 143 distinct ids, 0 ambiguous.
 *
 * -- 🔴 SHOP TERMINALS: WHY THIS BUILDS WHAT AN EARLIER FLIGHT CORRECTLY REJECTED ---------------
 *
 * `player-origin.ts` carries the census that killed the first proposal, and it is still right about
 * what it measured: a persisted `shopName -> place` map buys **37 minutes across 382.6 hours** and
 * poisons itself (`SCShop_Cargo_Office` exists at 13 stations; a 300 s learning window already had
 * 5 of 27 pairings wrong). Nothing here reopens that. **No terminal binding is ever persisted.**
 *
 * What is built here answers two questions the census never asked:
 *
 * **RESILIENCE.** Sub: *"At any time CIG can update the logs to remove information. If we can get
 * the player's location from multiple different sources, then if they change something in the
 * future we may not even need to change anything with our app."* A source that merely repeats a
 * fix we already hold is worth nothing today and is insurance tomorrow — but only if it is
 * genuinely INDEPENDENT. A terminal fix learned from a location line is not independent; it dies
 * with the line it learned from. So there are two terminal paths, and only the second is insurance:
 *
 *   - `shopId` bound in-session to a place a location line named. Precise, certain, dependent.
 *   - **the shop's own name, resolved against the starmap.** Independent of every other signal.
 *     Measured over the corpus: **28 of 61 shop names resolve to exactly one starmap row, 0 resolve
 *     ambiguously**, and those 28 cover 1,873 of 2,549 shop lines.
 *
 * 🔴 THE RESOLVED ROW'S OWN `type` DECIDES THE TIER — never the fact that a shop name mentioned it.
 * Five names (`SCShop_Pyro_RStop_*`) resolve to **Pyro, which is a Star**, so reporting them as a
 * `place` would put the player at the centre of a sun. They become a SYSTEM reading, which is all
 * they ever said. This is also what makes the earlier flight's warning harmless rather than
 * something to guard against separately: `SCShop_AdminOffice_Nyx_SocialStation` sits at three
 * different Keeger bases, and it resolves to **nothing at all** — "Nyx" is a Star and
 * "SocialStation" is not a row — so the unique-or-nothing rule the module already lives by filters
 * the dangerous case without a special case for it.
 *
 * **PRECISION.** Station-level is enough for a distance and not enough for *"meet me at the cargo
 * office at Levski"*. The terminal names WHICH terminal (`shopName`, `kioskId`) inside the station,
 * which is new capability rather than a duplicate one. That rides as `detail` on the verdict and
 * changes no tier: the PLACE still comes from a binding or from the starmap, and the shop name only
 * ever says which desk you were standing at.
 *
 * ⚠️ NOTHING HERE LEAVES THE MACHINE. This is an internal service, not a network surface — the
 * verdict is read by the sidecar's own routes. A future "drop a pin in chat" would be a deliberate
 * publish of a value the player chose to send; nothing in this design forecloses that, and nothing
 * in it performs it.
 *
 * 🔑 Re-derive every number above with `npm run measure:origin`. It exits non-zero when a
 * conclusion is overturned, because a census written into a comment is a claim that rots.
 */
import { PlaceWatcher, SystemWatcher, type Place } from "./location.js";
import type { SignalInputs, TerminalFix } from "./origin-signals.js";

/**
 * How close a numeric id and a readable token must appear to count as the same visit.
 *
 * Inherited deliberately from `PLACE_BIND_WINDOW_MS` in `overlay-server.ts` rather than re-chosen:
 * the two mechanisms learn the same pairing and disagreeing about what "the same visit" means would
 * make them bind different things from one log. Generous on purpose — the ASOP and the freight lift
 * are different terminals at one site and a player wanders between them over minutes.
 *
 * 🔑 The window is not what keeps this safe; the measurement is. Across the whole corpus this
 * window produced **812 in-session bindings and 0 ambiguous ones**, which is the opposite of what
 * the same window did to the shop-NAME map (5 of 27 wrong). A number is a site; a name is an asset.
 */
export const BIND_WINDOW_MS = 5 * 60_000;

/** The `shopId[...]` / `shopName[...]` / `kioskId[...]` fields ride BOTH shop components:
 *  `CEntityComponentCommodityUIProvider` (bulk commodities) and `CEntityComponentShopUIProvider`
 *  (gear, weapons, food). The second is the bigger half — 484 lines against 311 — and nothing in
 *  the app read it before. Matching the component tag rather than the bare field keeps this from
 *  claiming any future line that happens to carry a `shopId`. */
const SHOP_COMPONENT = "CEntityComponent";
const SHOP_TAIL = "UIProvider::";
const SHOP_NAME_RE = /shopName\[([^\]]*)\]/;
const SHOP_ID_RE = /shopId\[([^\]]*)\]/;
const KIOSK_ID_RE = /kioskId\[([^\]]*)\]/;

/** A shop line, if this is one. Exported for the test and for the measurement tool, so a prefilter
 *  can never drift from what the parser accepts — the lesson `trade-log.ts` paid for. */
export function parseShopLine(line: string): { shopId: string; shopName: string; kioskId: string | null } | null {
  // Cheap reject first: the component tag, then the one field that must be present.
  const c = line.indexOf(SHOP_COMPONENT);
  if (c < 0) return null;
  const t = line.indexOf(SHOP_TAIL, c);
  if (t < 0) return null;
  const between = line.slice(c + SHOP_COMPONENT.length, t);
  if (between !== "Commodity" && between !== "Shop") return null;
  const id = SHOP_ID_RE.exec(line);
  const nm = SHOP_NAME_RE.exec(line);
  if (!id?.[1] || !nm?.[1]) return null;
  return { shopId: id[1], shopName: nm[1], kioskId: KIOSK_ID_RE.exec(line)?.[1] || null };
}

/**
 * Turn the game's own shop asset name into something a person would say.
 *
 * `SCShop_Levski_CargoOffice_Commodities` -> "Levski Cargo Office Commodities".
 *
 * ⚠️ THIS IS A LABEL, NEVER EVIDENCE. It is the asset's name, so it can carry a place token that is
 * wrong about the place — that is the whole finding behind the rejected map. It is shown as "which
 * terminal", and the PLACE always comes from somewhere else.
 */
export function terminalLabel(shopName: string): string {
  const stem = shopName.replace(/^SCShop_?/i, "").replace(/-\d+$/, "");
  const words = stem.split(/[_\-]+/).filter(Boolean)
    // Split camelCase (`CargoOffice`) without touching an already-split word.
    .flatMap((w) => w.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(" "))
    .filter(Boolean);
  if (!words.length) return shopName;
  return words.map((w) => (w.length <= 2 ? w : w[0].toUpperCase() + w.slice(1))).join(" ");
}

export interface PlayerLocationDeps {
  /** `body key -> display name`, for PlaceWatcher. */
  bodyNames?: Record<string, string>;
  /** Known system names, lowercase, for SystemWatcher. */
  knownSystems?: Set<string>;
  /** The PERSISTED numeric-id bindings. Read on every lookup rather than copied in, so a binding
   *  learned by the hauling path is visible here immediately. */
  savedPlaceIds?: () => Record<string, string>;
  /** Persist a newly learned numeric-id binding. Called only when the binding is NEW or CHANGED,
   *  so a settled map costs no writes. Numeric ids are stable across sessions (measured); terminal
   *  bindings are deliberately given no equivalent. */
  savePlaceId?: (id: string, token: string) => void;
  now?: () => number;
}

/**
 * What the session knows about where the player is.
 *
 * 🔑 IT DOES NOT PARSE THE MISSION LOG ITSELF. `HaulingTracker` already extracts the three
 * player-action location events and does it well; duplicating that parse would give the app two
 * answers to one question, which is the disease this file is the cure for. The hauling view is
 * passed IN to `inputs()`. What this owns is the state nothing else did: the two watchers, and the
 * bindings that turn an opaque id into a place.
 */
export class PlayerLocation {
  readonly place: PlaceWatcher;
  readonly system: SystemWatcher;

  /** shopId -> the place token a location line named while the player was at that terminal.
   *  🔴 IN-SESSION ONLY, AND NEVER PERSISTED. This is the whole safety margin of the terminal
   *  source: a binding that cannot outlive the session cannot be wrong about a later one. */
  private shopPlaces = new Map<string, string>();
  /** The last terminal the player touched, whether or not it is bound to a place. Carried even
   *  unbound, because the LABEL is useful on its own ("you were at the Cargo Office") and because
   *  the starmap fallback reads the name rather than the binding. */
  private lastShop: { shopId: string; shopName: string; kioskId: string | null; at: number } | null = null;

  constructor(private deps: PlayerLocationDeps = {}) {
    this.place = new PlaceWatcher(deps.bodyNames ?? {});
    this.system = new SystemWatcher(deps.knownSystems ?? new Set(["pyro", "stanton", "nyx"]));
  }

  private now(): number { return this.deps.now ? this.deps.now() : Date.now(); }

  /**
   * Feed one raw log line.
   *
   * 🔴 `at` IS THE LOG'S OWN TIMESTAMP, and the seed must pass it. Both watchers default to the
   * wall clock, which is correct while tailing and wrong on a replay — see the module header.
   * Returns which watcher changed so the caller can broadcast exactly what it used to.
   */
  push(line: string, at: number = this.now()): { placeChanged: boolean; systemChanged: boolean } {
    const placeChanged = this.place.push(line, at);
    const systemChanged = this.system.push(line, at);
    const shop = parseShopLine(line);
    if (shop) this.lastShop = { ...shop, at };
    return { placeChanged, systemChanged };
  }

  /**
   * Learn what an opaque id names, from a readable token seen at the same visit.
   *
   * Called with whatever the hauling tracker currently holds; it is idempotent, so calling it every
   * line, every request or once a minute all give the same map.
   *
   * ⚠️ A binding is only learned while BOTH readings are inside the window. Learning from a token
   * alone would be inventing the pairing the log never states — the rule the numeric event's own
   * note lays down.
   */
  learn(named: { token: string; at: number } | null | undefined,
        numeric: { id: string; at: number } | null | undefined): void {
    if (!named) return;
    if (numeric && Math.abs(named.at - numeric.at) <= BIND_WINDOW_MS) {
      const saved = this.deps.savedPlaceIds?.() ?? {};
      if (saved[numeric.id] !== named.token) this.deps.savePlaceId?.(numeric.id, named.token);
    }
    const shop = this.lastShop;
    if (shop && Math.abs(named.at - shop.at) <= BIND_WINDOW_MS) {
      this.shopPlaces.set(shop.shopId, named.token);
    }
  }

  /** The place token a numeric id stands for, or null. Persisted map only — an in-session numeric
   *  binding would be the same thing with a shorter life, and the id is stable across sessions. */
  placeForId(id: string | null | undefined): string | null {
    if (!id) return null;
    return (this.deps.savedPlaceIds?.() ?? {})[id] ?? null;
  }

  /** What the last terminal touched can contribute. Null when no terminal has been used. */
  terminal(): TerminalFix | null {
    const s = this.lastShop;
    if (!s) return null;
    return {
      at: s.at,
      shopName: s.shopName,
      kioskId: s.kioskId,
      label: terminalLabel(s.shopName),
      /** The dependent, precise path: what a location line said while we were here. */
      boundToken: this.shopPlaces.get(s.shopId) ?? null,
    };
  }

  /** Only for the tests and the diagnostics report — how many terminals this session has placed. */
  boundTerminals(): number { return this.shopPlaces.size; }

  /**
   * Everything `collectOriginSignals` grades, assembled once.
   *
   * The hauling readings are passed in rather than parsed here; see the class note.
   */
  inputs(hauling: {
    atLocation?: { token: string; at: number } | null;
    atLocationId?: { id: string; at: number } | null;
    cargoMove?: { direction: "down" | "up"; platform: string; at: number } | null;
  } = {}): SignalInputs {
    const named = hauling.atLocation ?? null;
    const numeric = hauling.atLocationId ?? null;
    this.learn(named, numeric);
    const bound = this.placeForId(numeric?.id);
    return {
      place: this.place.current(this.now()) as Place,
      system: this.system.current(),
      atLocation: named,
      atLocationId: numeric,
      cargoMove: hauling.cargoMove ?? null,
      // 🔑 The numeric id, RESOLVED. Handing the collector the raw number is what made this signal
      // invisible for as long as it existed: nothing downstream can turn `3490636373` into a place.
      boundPlace: bound && numeric ? { token: bound, at: numeric.at } : null,
      terminal: this.terminal(),
    };
  }
}
