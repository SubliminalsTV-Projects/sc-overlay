// Auto-loading: which ships have it, and what it costs in time.
//
// Why this file exists as a shared constant rather than living in whichever module needed it
// first: three separate concerns depend on it — the contract advisor (a ship that auto-loads
// changes which contracts are worth taking), the packer (an auto-loading ship needs no packing
// plan at all), and the widget (it must not render a stowage diagram nobody will use).

/** Seconds the game charges to auto-load ONE box, by SCU size.
 *  Verbatim from `globalcargoloadingparams/globalcargoloadingdata.xml`
 *  (`autoLoadingBoxSizeLoadingTime`, 4.9.0-LIVE.12344265). Unloading is the same table.
 *
 *  🔑 This is CIG's own difficulty curve and it is the opposite of the manual case: per SCU a
 *  32-box costs 0.56s and a 1-box costs 2s, so under auto-load BIGGER BOXES ARE ~3.6x CHEAPER.
 *  Manual tractor-beam work has no published timing, and there the count of boxes dominates
 *  (Sub, 2026-08-16: "six 1 SCU boxes is about the same work as six 32 SCU boxes"). Any ranking
 *  that ignores which regime a ship is in will recommend backwards for one of them. */
export const AUTOLOAD_SECONDS_BY_SCU: Readonly<Record<number, number>> = {
  1: 2, 2: 3, 4: 5, 8: 8, 16: 12, 24: 15, 32: 18,
};

/** Flat seconds charged per load and per unload, on top of the per-box table. */
export const AUTOLOAD_BASE_SECONDS = 120;

/** Seconds per SCU moved across the station's cargo deck (freight elevator side). */
export const CARGO_DECK_SECONDS_PER_SCU = 0.024;

/** ⚠️ HAND-MAINTAINED, and deliberately so — Sub's call 2026-08-16.
 *  There is NO auto-load capability flag anywhere in the ship data: `inventorycontainers` does
 *  not carry one, and neither does the entity tree. This list came from Sub's chat (players who
 *  actually fly these) and every className below was verified to exist in `data/ships.json`.
 *  The rule they described is "open ships" — an exposed deck a loading arm can reach.
 *
 *  If a new open hauler ships, this list is what needs updating; nothing will detect it. */
export const AUTOLOAD_SHIP_CLASSES: ReadonlySet<string> = new Set([
  "MISC_Hull_A", "MISC_Hull_B", "MISC_Hull_C",
  "ARGO_RAFT",
  "DRAK_Golem_OX",
  "DRAK_Ironclad", "DRAK_Ironclad_Assault",
  "GAMA_Railen",
  "GAMA_Syulen", "GAMA_Syulen_Exec_Military", "GAMA_Syulen_Exec_Stealth",
  "CNOU_Nomad",
]);

/**
 * ⚠️ REPORTED, NOT MEASURED — and it must stay labelled that way.
 *
 * The stow tab told Sub "Hull A loads itself" for every contract on his board, and he caught it:
 * "it's lying to us. It only loads itself on specific missions." His understanding is that
 * automated loading is a perk of the higher hauling contracts, from Experienced upward.
 *
 * 🔴 THERE IS NO FLAG FOR THIS ANYWHERE IN THE DATA. `hauling-orders.json` carries no auto-load
 * field, the ship data carries none either (see AUTOLOAD_SHIP_CLASSES, hand-maintained for exactly
 * the same reason), and nothing in the log announces it. So this is one player's reading of the
 * game, encoded so the widget stops making a claim it cannot support — NOT a fact extracted from
 * CIG's files. If it turns out to be wrong, this constant is the single place to change.
 */
export const AUTOLOAD_MIN_RANK = "Experienced";

/** Rank tiers, lowest first — the order the min-rank rule is judged against. Kept here rather than
 *  imported so this module stays free of the advisor. */
const RANK_ORDER: readonly string[] = ["Trainee", "Rookie", "Junior", "Member", "Experienced", "Senior", "Master"];

/** Does a contract at this board rank get the station arm? Unknown rank => false: claiming a
 *  capability we cannot check is the bug this exists to fix. */
export function rankAutoLoads(rank: string | null | undefined): boolean {
  if (!rank) return false;
  const i = RANK_ORDER.indexOf(rank);
  const min = RANK_ORDER.indexOf(AUTOLOAD_MIN_RANK);
  return i >= 0 && i >= min;
}

export function canAutoLoad(shipClass: string | null | undefined): boolean {
  return !!shipClass && AUTOLOAD_SHIP_CLASSES.has(shipClass);
}

/** Total seconds to auto-load a manifest, one way. `boxes` is SCU size -> count.
 *  Returns null for a ship that cannot auto-load — the caller must fall back to the manual
 *  model rather than silently pricing a capability the player does not have. */
export function autoLoadSeconds(
  shipClass: string | null | undefined,
  boxes: Readonly<Record<number, number>>,
): number | null {
  if (!canAutoLoad(shipClass)) return null;
  let s = AUTOLOAD_BASE_SECONDS;
  for (const [scu, n] of Object.entries(boxes)) {
    const per = AUTOLOAD_SECONDS_BY_SCU[Number(scu)];
    // An unknown size is not free — fall back to the nearest known size below it rather than
    // adding 0, which would quietly under-price a load. Fractional boxes really are 0.
    if (per == null) {
      const known = Object.keys(AUTOLOAD_SECONDS_BY_SCU).map(Number).filter((k) => k <= Number(scu));
      s += (known.length ? AUTOLOAD_SECONDS_BY_SCU[Math.max(...known)] : 0) * n;
    } else s += per * n;
  }
  return s;
}
