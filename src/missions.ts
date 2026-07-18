/**
 * Mission/blueprint state engine.
 *
 * Consumes MissionEvents from the parser and maintains:
 *   - which mission is currently TRACKED (latest objective marker wins),
 *   - that mission's blueprint reward POOL (from the bundled per-patch dataset),
 *   - which blueprints you've COLLECTED — "observed" (seen in `Received Blueprint`
 *     events) plus manual owned/not-owned overrides — persisted across sessions.
 *
 * The log can't read your full account inventory, so "collected" = what the app has
 * witnessed, seeded/corrected by manual overrides. See data/README.md.
 */
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseMissionEvent, type MissionEvent } from "./missions-parser.js";
import { categorize, type TabKey } from "./categories.js";
import { parseLine } from "./parser.js";

// ---- dataset shape (matches tools/build-blueprint-data.sql output) ----
export interface PoolEntry {
  blueprint: string;
  chance: number;
  item: string | null;
  /** Item taxonomy (from the dataset) used to bucket into fabricator categories.
   *  `type` is always present; `classification`/`subType` refine the sub-category. */
  type?: string | null;
  subType?: string | null;
  classification?: string | null;
}
/** A reputation change a mission applies on completion (schema/2). faction = the org
 *  affected; scope is e.g. "FactionReputation"; amount is the raw game value. */
export interface RepEntry {
  faction: string;
  scope: string;
  amount: number;
}
/** One rank on a reputation scope's ladder: the rep floor to reach it + its name. */
export interface RepLadderRank {
  minRep: number;
  name: string;
}
/** A reputation scope (e.g. "FactionReputation") and its ordered rank ladder, from
 *  data/rep-scopes.json (extracted from the p4k datacore — sc-api doesn't carry it).
 *  Ranks are in the game's ORIGINAL list order; some scopes (Wikelo) list best-first,
 *  so consumers sort by minRep for display. */
export interface RepScope {
  displayName: string | null;
  ranks: RepLadderRank[];
}
export interface RepScopes {
  schema: string;
  source?: string;
  scopes: Record<string, RepScope>;
}
/** Reputation progress-bar state for the tracked mission's giver (see computeRepBar). */
export interface RepBar {
  /** The rep scope driving the ladder, e.g. "FactionReputation". */
  scope: string;
  /** The org/faction this standing belongs to (the mission's giver). */
  faction: string;
  /** Current standing NAME (e.g. "Veteran Contractor"). */
  standing: string;
  /** Estimated rep total (lower bound). */
  estimate: number;
  /** Rep floor of the current rank + the next rank's floor/name (null at max rank). */
  curMin: number;
  nextMin: number | null;
  nextName: string | null;
  /** True at the top of the ladder (no next rank). */
  max: boolean;
  /** No completions witnessed yet for this giver (run Verify from logs) — the UI shows an
   *  empty "estimate unavailable" state instead of a misleading zero-progress bar. */
  noData: boolean;
}
export interface DatasetMission {
  title: string;
  generatorClass: string;
  missionKey: string;
  /** Mission-giving org / faction (schema/2), e.g. "Hockrow Agency". Display-only. */
  giver?: string | null;
  /** Mission type (schema/2), e.g. "Investigation", "Salvage". Display-only. */
  missionType?: string | null;
  pools: Record<string, PoolEntry[]>;
  /** Static aUEC payout (schema/2). Most missions are runtime-calculated → null.
   *  min is often 0, meaning "up to max". Currency is UEC or MER (prison merits). */
  payout?: { min: number | null; max: number; currency: string | null } | null;
  /** ITEM rewards the mission hands out (schema/2) — actual items (Wikelo ships,
   *  armor, scrip), NOT blueprints. No ownership tracking; display-only. */
  items?: { name: string; item: string | null; amount: number }[] | null;
  /** Reputation gained (+) / lost (−) on completion, biggest first (schema/2).
   *  Empty/absent for the many missions the game data carries no rep for. */
  reputationGained?: RepEntry[];
  reputationLost?: RepEntry[];
  /** Reputation RANK this mission requires (0,1,2…); null/absent = no rank gate (intro
   *  + story missions). The game only offers it once you've reached that rank, so
   *  accepting it proves you're at least there — that's how we infer standing. */
  rank?: number | null;
}
export interface Dataset {
  schema: string;
  version: string;
  changelist: string;
  missionCount: number;
  missions: Record<string, DatasetMission>;
  /** Starter-gear blueprints every account owns by default. NOT mission rewards and
   *  never logged as "Received Blueprint", so they only become "owned" via this list.
   *  Populated by the dataset generator from sc-api (item UUID + display name). */
  defaults?: { name: string; item: string }[];
  /** Global name -> item-UUID index of EVERY blueprint in the game, not just mission
   *  pools. Lets a "Received Blueprint" receipt resolve to its item even when it came
   *  from a source we don't model as a pool (e.g. dynamic-event contribution tiers like
   *  XenoThreat, which drop with an all-zeros MissionId). Without it those receipts
   *  count toward the collected total but map to no UUID — no owned flag, no site sync.
   *  Consulted by itemUuidsForName only after mission pools miss. */
  index?: { name: string; item: string }[];
}

// ---- overlay-facing view ----
/** How a blueprint came to be owned:
 *   in-game  — witnessed a "Received Blueprint" receipt in the log,
 *   manual   — the user ticked it on (seeds inventory the log can't see),
 *   default  — starter gear every account owns (see DEFAULT_BLUEPRINTS).
 *   null     — not owned. */
export type BlueprintSource = "in-game" | "manual" | "default" | null;

export interface BlueprintStatus {
  name: string;
  owned: boolean;
  /** Why we think it's owned (in-game / manual / default), or null when not owned. */
  source: BlueprintSource;
  chance: number;
  /** Fabricator category tab (matches the in-game filter) + text sub-category. */
  tab: TabKey;
  sub: string;
}
/** A completed mission in the recent-activity list (idle overlay state). */
export interface RecentMission {
  title: string | null;
  aUEC: number | null;
  /** ISO-8601 completion time from the log (null if unparseable). */
  at: string | null;
}
/** A received blueprint in the recent-activity list. */
export interface RecentBlueprint {
  name: string;
  /** ISO-8601 receipt time from the log. */
  at: string | null;
}
/** A blueprint unlocked during a mission — the completion card shows its item image. */
export interface BlueprintReward {
  name: string;
  /** Resolved item UUID (the image key), or null if the name couldn't be resolved. */
  item: string | null;
  /** Full item-render URL on the site, or null when there's no UUID. */
  image: string | null;
}

export interface TrackedView {
  /** The loaded dataset's version (the pools being shown). */
  patch: string | null;
  /** The player's actual build changelist from the log (may differ from the dataset
   *  if their exact build isn't bundled — the UI flags that). */
  build: string | null;
  contractKey: string | null;
  title: string | null;
  generator: string | null;
  hasPool: boolean;
  /** Static aUEC payout for the shown mission, or null (most payouts are
   *  runtime-calculated and unknown statically). min 0/null = "up to max". */
  payout: { min: number | null; max: number; currency: string | null } | null;
  /** ITEM rewards (not blueprints) the shown mission hands out. Display-only. */
  /** Guaranteed ITEM rewards (not blueprints). `owned` is a manual, local-only tick —
   *  item awards never appear in the log, so it's never auto-set and never synced. */
  itemRewards: { name: string; amount: number; owned: boolean }[];
  /** Mission-giving faction/org and mission type for the shown mission (display-only). */
  giver: string | null;
  /** Inferred rank with this mission's giver: the highest-rank mission we've seen
   *  accepted from them. A LOWER BOUND (actual rep is server-side, never logged), and
   *  null until they accept a rank-gated mission from that giver. */
  inferredRank: number | null;
  /** Live "how close am I to ranking up" estimate for the tracked mission's giver, or
   *  null when there's no rep ladder for them. A LOWER BOUND: the sum of rep from
   *  completions witnessed since the 4.8 wipe (pre-tracker + non-pool history is
   *  unrecoverable, so it reads low, never high). `noData` until a completion is seen. */
  repBar: RepBar | null;
  missionType: string | null;
  /** Reputation gained (+) / lost (−) on completion, biggest first (may be empty). */
  reputationGained: RepEntry[];
  reputationLost: RepEntry[];
  /** True once the tracked mission has logged a COMPLETED end. */
  completed: boolean;
  pools: { poolUuid: string; blueprints: BlueprintStatus[] }[];
  totals: { owned: number; total: number };
  /** Lifetime collected count across all observed + overridden blueprints. */
  collectedTotal: number;
  /** Last few completed missions + received blueprints (newest first), shown on the
   *  overlay's idle state when no mission is tracked. Backfilled from the logs. */
  recentMissions: RecentMission[];
  recentBlueprints: RecentBlueprint[];
  /** Present for ~30s after the on-screen mission completes (~8s for an abandon):
   *  a summary card (payout, duration, blueprints received — or just "abandoned")
   *  shown before moving to the next mission. null the rest of the time. */
  completion: {
    title: string | null;
    /** How the mission ended — an abandoned card renders without stats. */
    kind: "completed" | "abandoned";
    /** aUEC awarded, or null if none correlated. */
    aUEC: number | null;
    /** Accept→complete duration in ms, or null if the accept wasn't seen. */
    durationMs: number | null;
    /** Blueprints received during the mission (name + item image for the card). */
    blueprints: BlueprintReward[];
  } | null;
  /** The manually-pinned missionId, or null when auto-following. */
  selectedId: string | null;
  /** Every mission seen this session, newest first — powers the overlay picker.
   *  The log can't say which mission you've *selected* to track in-game, so the
   *  user picks; auto-mode shows the newest one that actually has a pool. */
  missions: { id: string; title: string; contractKey: string | null; hasPool: boolean }[];
  /** For dynamic-event missions that don't drop blueprints from a pool (e.g. Return
   *  of XenoThreat): the event's reward ladder to show instead of "no reward". The
   *  points are INDIVIDUAL — every event mission you run raises YOUR own %. */
  eventTrack: EventTrack | null;
  /** True when the tracked mission was resolved from a title that maps to several
   *  variants with DIFFERENT pools (marker-less missions only) — the pool shown is the
   *  UNION of all candidates, so odds are approximate. Overlay shows a caveat banner. */
  ambiguous?: boolean;
}

/** A dynamic-event reward ladder — rewards unlock at personal contribution %. */
export interface EventTrack {
  name: string;
  /** One-line note telling the player where to see their % (in-game journal). */
  note: string;
  tiers: { pct: number; items: { name: string; owned: boolean; source: BlueprintSource }[] }[];
}

// Return of XenoThreat reward ladder — mirrors the site's blueprints-extra.json.
// Blueprint names are exactly as they appear in the log's "Received Blueprint" lines
// so owned-status matches via the observed set. Rewards unlock at personal
// contribution % (individual, not server-wide). Detection: the tracked mission's
// generator is "TheBackpocket" or its contract starts with "RoX_".
const XENOTHREAT_TIERS: { pct: number; items: string[] }[] = [
  { pct: 15, items: ["Chiron Helmet Purgatory Camo", "Chiron Core Purgatory Camo", "Chiron Arms Purgatory Camo", "Chiron Legs Purgatory Camo", "Chiron Backpack Purgatory Camo", 'BR-2 "Purgatory Camo" Shotgun'] },
  { pct: 25, items: ["Testudo Helmet Purgatory Camo", "Testudo Core Purgatory Camo", "Testudo Arms Purgatory Camo", "Testudo Legs Purgatory Camo", "Testudo Backpack Purgatory Camo", 'S71 "Purgatory Camo" Rifle'] },
  { pct: 50, items: ["Monde Helmet Purgatory Camo", "Monde Core Purgatory Camo", "Monde Arms Purgatory Camo", "Monde Legs Purgatory Camo", 'Demeco "Purgatory Camo" LMG', "Warden Backpack Purgatory Camo"] },
  { pct: 60, items: ["QuadraCell", "QuadraCell MT"] },
  { pct: 85, items: ["FR-66", "FR-76"] },
  { pct: 100, items: ["NDB-26 Repeater", "NDB-28 Repeater", "NDB-30 Repeater"] },
];
const XENOTHREAT_NOTE =
  "Every XenoThreat mission you run adds to YOUR personal progress (not the server's). Check your in-game Journal → Return of XenoThreat for your current %.";

/** A dynamic-event mission whose rewards come from the personal contribution ladder,
 *  not a blueprint pool (Return of XenoThreat). Keyed off the shared generator. */
function isXenoThreatMission(contractKey: string | null, generator: string | null): boolean {
  return generator === "TheBackpocket" || !!contractKey?.startsWith("RoX_");
}

interface Persisted {
  observed: string[];
  overrides: Record<string, boolean>;
  /** blueprint name -> earliest in-game unlock time (ISO-8601 UTC from the log).
   *  Optional: older state files predate it; a "Verify from logs" run backfills it. */
  observedAt?: Record<string, string>;
  /** Recently completed missions (newest first), for the idle recent-activity list.
   *  Optional: older state files predate it; a "Verify from logs" run backfills it. */
  missionHistory?: MissionHistoryEntry[];
  /** Guaranteed ITEM rewards (jumpsuits, hats — not blueprints) the user ticked off by
   *  hand. The log never reports these, so they're manual-only. Kept separate from
   *  `overrides` so they never inflate the blueprint collected count or the site sync. */
  guaranteedOwned?: string[];
  /** Inferred reputation standing: mission giver -> highest rank we've seen them
   *  accept a mission at. Rep is server-side (never in the log), so this is the best
   *  available signal — a lower bound that only improves as they rank up. */
  inferredRank?: Record<string, number>;
  /** giver -> witnessed reputation total on their primary org scope (post-4.8 completions).
   *  A lower bound rebuilt by "Verify from logs"; older state files predate it. */
  repWitnessed?: Record<string, { scope: string; sum: number }>;
}

/** Stored completed-mission record (newest first, capped). Deduped by missionId+at. */
interface MissionHistoryEntry {
  missionId: string | null;
  title: string | null;
  aUEC: number | null;
  at: string;
}

/** "Geist Armor Arms" matches an observed "Geist Armor Arms Whiteout" (variant suffix). */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** SC ship-component blueprints are logged with a classification designation the
 *  dataset doesn't carry — "Mil/2/B Bolide" (Class/Size/Grade + model) or the
 *  quantum-drive form `STL-1B "Zephyr"` (code + quoted model) — while the dataset
 *  stores the bare model ("Bolide", "Zephyr"). Return the bare-model form when a name
 *  looks like a component designation, else null. Used as a resolve fallback only, so
 *  a stray match can't hurt: the stripped candidate still has to hit the dataset. */
function componentModel(received: string): string | null {
  // Class/Size/Grade prefix: "Mil/2/B ", "Ind/0/C ", "Civ/3/D ", "Sth/1/A ", …
  const cls = received.match(/^[A-Za-z]{2,4}\/\d+\/[A-Za-z0-9]+\s+(.+)$/);
  if (cls) return cls[1].trim();
  // Code + quoted model at the end: `STL-1B "Zephyr"` -> "Zephyr" (but NOT a variant
  // like `BR-2 "Purgatory Camo" Shotgun`, which has text after the quote).
  const qd = received.match(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\s+"([^"]+)"\s*$/);
  if (qd) return qd[1].trim();
  return null;
}

function matchesPoolName(poolName: string, owned: Iterable<string>): boolean {
  const p = norm(poolName);
  for (const o of owned) {
    const n = norm(o);
    // Owned satisfies the pool entry only if it IS that entry, or a longer variant
    // of it ("Geist Armor Arms Whiteout" owns pool "Geist Armor Arms"). NOT the reverse:
    // owning the base "Geist Armor Arms" must not claim a more-specific pool entry like
    // "Geist Armor Arms ASD Edition" — those are distinct blueprints. Mirrors resolveName.
    if (n === p || n.startsWith(p + " ")) return true;
    // Component designation → bare model (pool carries the bare model name).
    const model = componentModel(o);
    if (model && norm(model) === p) return true;
  }
  return false;
}

const CHANGELIST_RE = /build_version\[(\d+)\]|Changelist:\s*(\d+)/;
/** Pull the build changelist from a raw log line (header), or null. */
export function detectChangelist(rawLine: string): string | null {
  const m = rawLine.match(CHANGELIST_RE);
  return m ? (m[1] ?? m[2]) : null;
}

/** The 4.8 patch wiped reputation, so only completions from 4.8+ logs count toward the
 *  rep bar. Version family is "major.minor". Unknown/unparseable → excluded (conservative:
 *  avoids counting pre-wipe rep we can't date). */
export function familyAtLeast48(family: string | null): boolean {
  if (!family) return false;
  const [maj, min] = family.split(".").map(Number);
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return false;
  return maj > 4 || (maj === 4 && min >= 8);
}

/** Which rep scope is a giver's PRIMARY, mobiGlas-facing standing when a mission grants
 *  several (a Foxwell mission gives FactionReputation AND Security — the org rank is the
 *  former). Earlier = higher priority; anything not listed sorts last. */
const REP_SCOPE_PRIORITY = [
  "FactionReputation",
  "MissionProviderReputation_Battaglia",
  "Wikelo",
  "BountyHunter_BountyHuntersGuild",
  "Hauling",
  "Salvaging",
  "Security",
  "BountyHunter",
];
/** Internal / non-standing rep modifiers that never get their own progress bar even
 *  when a mission grants them (combat affinity, racing, worker/theft counters). The
 *  bundled rep-scopes.json already drops the placeholder ladders (Affinity, NPC_*). */
const REP_SCOPE_DENY = /^(ShipCombat_|FPS_Combat|Racing|Worker|Theft|Assassination|HiredMuscle|.*TimeTrial)/;

/** Place a witnessed-rep estimate on a scope's ladder. estimate = sum of rep earned
 *  from completed missions since the 4.8 wipe — the only signal we trust. (Mission
 *  `rank_index` is a difficulty TIER, not a standing gate — grabbing a "rank-4" bounty
 *  doesn't prove rank 4 — so it is deliberately NOT used here.) Ranks are placed by
 *  minRep, so a best-first ladder (Wikelo) works too. `noData` flags "no completions
 *  witnessed yet" (run Verify from logs). Pure + exported so it's unit-testable. */
export function repLadderPosition(
  scope: RepScope | undefined,
  witnessed: number,
): Omit<RepBar, "scope" | "faction"> | null {
  if (!scope || scope.ranks.length < 2) return null;
  const asc = [...scope.ranks].sort((a, b) => a.minRep - b.minRep);
  const estimate = Math.max(0, witnessed);
  let cur = asc[0];
  let next: RepLadderRank | null = null;
  for (const r of asc) {
    if (r.minRep <= estimate) cur = r;
    else { next = r; break; }
  }
  return {
    standing: cur.name,
    estimate,
    curMin: cur.minRep,
    nextMin: next?.minRep ?? null,
    nextName: next?.name ?? null,
    max: next == null,
    noData: witnessed <= 0,
  };
}

/** How long to keep a just-completed mission's summary card up before moving on. */
const COMPLETION_HOLD_MS = 30_000;
/** Abandoned missions get a shorter hold — just enough to explain the vanishing pool. */
const ABANDON_HOLD_MS = 8_000;
/** An "Awarded N aUEC" counts as a mission's payout if it fired within this of the
 *  completion (the award's own missionId is null, so we correlate by log time). */
const REWARD_WINDOW_MS = 6_000;
/** Only show the completion card for a real-time completion — not the historical
 *  ones replayed when the app seeds from the log on startup. */
const COMPLETION_FRESH_MS = 90_000;
/** How many completed missions to retain for the idle recent-activity list. */
const MISSION_HISTORY_MAX = 20;

export interface MissionTrackerOptions {
  /** Directory holding blueprints.<changelist>.json (+ blueprints.latest.json). */
  dataDir: string;
  /** Where to persist collected state. Defaults to %APPDATA%/sc-blueprint-tracker. */
  stateDir?: string;
  /**
   * Optional base URL of a public dataset endpoint (e.g. a subliminal.gg route).
   * When set, a patch we don't have bundled is fetched + cached so the app stays
   * current without re-shipping. Always falls back to bundled data when offline.
   */
  remoteBaseUrl?: string;
}

/** Normalize a mission title for screen-OCR matching: uppercase, strip everything but
 *  letters/digits/spaces (so quotes, colons, punctuation drop out), collapse spaces. */
function normScreenTitle(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Match an OCR-read mission title against the accepted missions, tolerant of the ways
 * the read differs from the log's title, but tie-safe (an ambiguous read returns null,
 * never a guess). In order, each step accepts only a UNIQUE candidate:
 *   1. exact (normalized) equality;
 *   2. prefix either direction — the in-game tracked-mission panel truncates long titles
 *      ("Terrorist Shigemori \"Jester\" Amsden to be" vs "…to be Neutralized");
 *   3. containment either direction — a leading/trailing OCR fragment;
 *   4. token overlap allowing ONE mismatched word — a mid-title OCR glitch
 *      (e.g. "Dropshot" misread "Oropshot").
 * Returns the matched mission id, or null.
 */
export function matchScreenTitle(
  rawTitle: string,
  candidates: { id: string; title: string }[],
): string | null {
  const want = normScreenTitle(rawTitle);
  if (!want) return null;
  const wantTokens = want.split(" ");
  const cs = candidates
    .map((c) => ({ id: c.id, t: normScreenTitle(c.title) }))
    .filter((c) => c.t);
  if (!cs.length) return null;

  let hits = cs.filter((c) => c.t === want);
  if (hits.length === 1) return hits[0].id;

  if (wantTokens.length >= 2) {
    hits = cs.filter((c) => c.t.startsWith(want) || want.startsWith(c.t));
    if (hits.length === 1) return hits[0].id;
    hits = cs.filter((c) => c.t.includes(want) || want.includes(c.t));
    if (hits.length === 1) return hits[0].id;
  }

  if (wantTokens.length >= 3) {
    hits = cs.filter((c) => {
      const ct = new Set(c.t.split(" "));
      const inter = wantTokens.filter((w) => ct.has(w)).length;
      return inter >= wantTokens.length - 1 && inter >= 3;
    });
    if (hits.length === 1) return hits[0].id;
  }

  return null;
}

export class MissionTracker extends EventEmitter {
  private dataDir: string;
  private stateDir: string;
  private statePath: string;
  private remoteBaseUrl?: string;

  private dataset: Dataset | null = null;
  private patch: string | null = null;
  private detectedChangelist: string | null = null;
  /** Version family (major.minor, e.g. "4.8") from the log header — picks the right
   *  dataset when the exact build isn't bundled. See detectPatch / loadDataset. */
  private detectedFamily: string | null = null;

  /** Guaranteed ITEM rewards ticked by hand (manual-only — the log never reports item
   *  awards). Deliberately NOT part of `observed`/`overrides`, so these never count
   *  toward the blueprint total nor sync to the site. */
  private guaranteedOwned = new Set<string>();
  /** giver -> highest mission `rank` we've seen accepted. Inferred standing (rep is
   *  server-side and never logged). Persisted, so it survives across sessions. */
  private inferredRank = new Map<string, number>();
  /** Reputation scope ladders (thresholds + rank names), loaded once from the bundled
   *  data/rep-scopes.json. Patch-independent (ladders change rarely); powers the rep bar. */
  private repScopes: Record<string, RepScope> = {};
  /** giver -> witnessed reputation on their primary org scope. `sum` accumulates the rep
   *  amount of each post-4.8 completion (a LOWER BOUND — pre-tracker history is gone).
   *  Live real-time completions add to it; verifyFromLogs rebuilds it authoritatively
   *  from every logbackup. See accrueRep / computeRepBar. */
  private repWitnessed = new Map<string, { scope: string; sum: number }>();
  /** normScreenTitle(mission title) -> the primary rep gain to credit when a mission with
   *  that title completes, or null when the title is ambiguous across givers/scopes. Built
   *  over ALL dataset missions (not just pooled ones), so combat/patrol/delivery missions
   *  with no blueprint reward still feed the rep bar. Same-org titles that differ only in
   *  amount (difficulty tiers) collapse to the MIN — a deliberate under-count. */
  private repTitleIndex = new Map<string, { giver: string; scope: string; amount: number } | null>();
  private observed = new Set<string>();
  /** blueprint name -> earliest in-game unlock time (ISO-8601 UTC from the log). */
  private observedAt = new Map<string, string>();
  private overrides = new Map<string, boolean>();

  /** missionId -> info, built from accept + marker events. `acceptedAt` (log time,
   *  ms) powers the mission-duration readout on the completion card. `acceptKeys`/
   *  `ambiguous` are set when a marker-LESS mission (mining/scan never emits a
   *  CreateMarker) was resolved from its accept TITLE instead of a debug_name. */
  private missions = new Map<string, { title?: string; contractKey?: string; generator?: string; acceptedAt?: number; acceptKeys?: string[]; ambiguous?: boolean }>();
  private trackedMissionId: string | null = null;
  /** missionIds in CreateMarker order, most recent last (deduped move-to-end). */
  private markerSeq: string[] = [];
  /** missionIds resolved from an accept TITLE (no marker), in accept order. Feeds the
   *  picker + auto-display so mining/scan missions — which never marker — still show. */
  private acceptedSeq: string[] = [];
  /** normScreenTitle(title) -> debug_names of pooled missions with that title. Built
   *  from the dataset on load; lets a marker-less accept resolve its pool by title. */
  private titleIndex = new Map<string, string[]>();
  /** Manual override from the overlay picker; null = auto-follow. */
  private selectedMissionId: string | null = null;
  /** The mission the screen OCR sees PINNED in-game (ground truth the log lacks).
   *  Improves auto-follow; a manual pick still wins. Set via setScreenMission(). */
  private screenMissionId: string | null = null;
  /** Has a CreateMarker fired since the last PU (re)entry? If not, don't auto-show
   *  a stale mission from a previous shard — wait for a marker or a manual pick. */
  private markerSinceJoin = false;
  private completedMissionIds = new Set<string>();
  /** Any mission that logged an end (complete/fail/abandon) — dropped from the
   *  active picker and auto-follow so only missions you currently have show. */
  private endedMissionIds = new Set<string>();

  /** The brief "mission complete" summary card, shown over the just-completed
   *  mission for COMPLETION_HOLD_MS before the overlay moves to the next mission.
   *  Only set for real-time completions (see beginCompletion). */
  private completion:
    | { missionId: string; title: string | null; kind: "completed" | "abandoned"; completedAtMs: number; acceptedAtMs: number | null; aUEC: number | null; until: number }
    | null = null;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last "Awarded N aUEC" seen (log time), to attach to the completion near it. */
  private lastReward: { amount: number; atMs: number } | null = null;
  /** Completed missions, newest first, capped — persisted for the idle recent list. */
  private missionHistory: MissionHistoryEntry[] = [];

  constructor(opts: MissionTrackerOptions) {
    super();
    this.dataDir = opts.dataDir;
    this.remoteBaseUrl = opts.remoteBaseUrl;
    this.stateDir =
      opts.stateDir ??
      join(process.env.APPDATA ?? process.env.HOME ?? ".", "sc-blueprint-tracker");
    this.statePath = join(this.stateDir, "collected.json");
    this.loadState();
    this.loadRepScopes();
  }

  /** Load the reputation rank ladders once from the bundled dataset. Optional — the rep
   *  bar just stays hidden if the file is missing (older bundles predate it). */
  private loadRepScopes(): void {
    try {
      const p = join(this.dataDir, "rep-scopes.json");
      this.repScopes = (JSON.parse(readFileSync(p, "utf8")) as RepScopes).scopes ?? {};
    } catch {
      this.repScopes = {};
    }
  }

  // ---- dataset / patch ----

  /** Detect the patch from a raw log line and (re)load the matching dataset.
   *  Tracks BOTH the build changelist and the version family (major.minor) — CIG's
   *  Perforce changelists aren't monotonic across branches (a later 4.8.2 hotfix can
   *  outnumber a 4.9.0 build), so the family is what disambiguates which dataset is
   *  correct when the exact build isn't bundled. The header lines can arrive in any
   *  order, so re-pick the dataset whenever either signal changes. */
  detectPatch(rawLine: string): void {
    const fam = rawLine.match(/(?:Product|File)Version:\s*(\d+\.\d+)/);
    const familyChanged = !!fam && fam[1] !== this.detectedFamily;
    if (familyChanged) this.detectedFamily = fam![1];
    const cl = detectChangelist(rawLine);
    const clChanged = !!cl && cl !== this.detectedChangelist;
    if (clChanged) this.detectedChangelist = cl;
    if (clChanged) void this.ensureDataset(cl!);
    else if (familyChanged) this.loadDataset(this.detectedChangelist ?? undefined);
  }

  /** Load the changelist's dataset, fetching it from the public endpoint first if we
   *  don't have it bundled and a remote URL is configured. Offline-safe. */
  async ensureDataset(changelist: string): Promise<void> {
    const local = join(this.dataDir, `blueprints.${changelist}.json`);
    if (!existsSync(local) && this.remoteBaseUrl) {
      try {
        const res = await fetch(`${this.remoteBaseUrl}/blueprints.${changelist}.json`);
        if (res.ok) {
          const text = await res.text();
          JSON.parse(text); // validate before caching
          writeFileSync(local, text);
        }
      } catch {
        /* offline — fall through to bundled / latest */
      }
    }
    this.loadDataset(changelist);
  }

  /** Load the right dataset: exact build → same version family → newest bundled.
   *  The family step matters when the exact build isn't shipped (a 4.8.2 player must
   *  get 4.8.2 pools, not the newest 4.9.0 — "latest" alone would be wrong). */
  loadDataset(changelist?: string): void {
    const candidates = [
      changelist ? join(this.dataDir, `blueprints.${changelist}.json`) : null,
      this.datasetPathForFamily(this.detectedFamily),
      join(this.dataDir, "blueprints.latest.json"),
    ].filter(Boolean) as string[];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        this.dataset = JSON.parse(readFileSync(p, "utf8")) as Dataset;
        this.patch = this.dataset.version;
        this.buildTitleIndex();
        this.buildRepTitleIndex();
        this.reresolveAccepts();
        this.emit("change");
        return;
      } catch {
        /* try next */
      }
    }
  }

  /** Path to the NEWEST bundled dataset in a version family ("4.9" → the highest 4.9.x
   *  changelist, not just the first one on disk). Within a family, changelists ARE
   *  monotonic, so the max changelist is the newest build — picking the first match
   *  instead served stale data (e.g. an old 4.9.0 with duplicate-ridden pools over the
   *  finalized 4.9.0). */
  private datasetPathForFamily(family: string | null): string | null {
    if (!family) return null;
    let best: { cl: number; path: string } | null = null;
    try {
      for (const f of readdirSync(this.dataDir)) {
        const mm = /^blueprints\.(\d+)\.json$/.exec(f);
        if (!mm) continue;
        const p = join(this.dataDir, f);
        try {
          const v = (JSON.parse(readFileSync(p, "utf8")) as Dataset).version;
          if (v && v.startsWith(family + ".")) {
            const cl = Number(mm[1]);
            if (!best || cl > best.cl) best = { cl, path: p };
          }
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* no data dir */
    }
    return best?.path ?? null;
  }

  // ---- event ingestion ----

  apply(ev: MissionEvent): void {
    switch (ev.kind) {
      case "accept": {
        const info = this.missions.get(ev.missionId) ?? {};
        if (ev.title) info.title = ev.title;
        if (ev.ts && info.acceptedAt == null) {
          const t = Date.parse(ev.ts);
          if (Number.isFinite(t)) info.acceptedAt = t; // first accept = mission start
        }
        // Marker-less missions (mining/scan) never emit a CreateMarker, so the log
        // gives only the friendly title — resolve it to the dataset so the mission
        // still shows a pool. A real marker (contractKey) always wins; this only fills
        // the gap. Runtime MissionId can't be used — it's an instance GUID, not the
        // definition UUID — so the title is the sole identifier we get.
        if (!info.contractKey) {
          const res = this.dataset && ev.title ? this.resolveAcceptTitle(ev.title) : null;
          if (res) {
            info.contractKey = res.keys[0]; // representative — drives pool/content lookups
            info.acceptKeys = res.keys;
            info.ambiguous = res.ambiguous;
            if (!this.acceptedSeq.includes(ev.missionId)) this.acceptedSeq.push(ev.missionId);
            this.markerSinceJoin = true; // a current, resolved mission is available to show
          } else if (!this.dataset && ev.title) {
            // Dataset not loaded yet (async fetch on a cold start replays the log first)
            // — register tentatively; reresolveAccepts() resolves or drops it on load.
            if (!this.acceptedSeq.includes(ev.missionId)) this.acceptedSeq.push(ev.missionId);
          }
        }
        this.missions.set(ev.missionId, info);
        this.noteRank(ev.missionId);
        this.emit("change");
        break;
      }
      case "marker": {
        const info = this.missions.get(ev.missionId) ?? {};
        info.contractKey = ev.contractKey;
        info.generator = ev.generator;
        // A marker is authoritative: the exact debug_name supersedes any title-guess.
        info.acceptKeys = undefined;
        info.ambiguous = false;
        this.acceptedSeq = this.acceptedSeq.filter((id) => id !== ev.missionId);
        this.missions.set(ev.missionId, info);
        this.noteRank(ev.missionId);
        // The most recent objective marker = the newest accepted mission.
        this.trackedMissionId = ev.missionId;
        this.markerSinceJoin = true;
        this.endedMissionIds.delete(ev.missionId); // a re-marked mission is active again
        this.markerSeq = this.markerSeq.filter((id) => id !== ev.missionId);
        this.markerSeq.push(ev.missionId);
        this.emit("change");
        break;
      }
      case "end": {
        // Capture whether this was the on-screen mission BEFORE marking it ended
        // (marking it ended removes it from effectiveMissionId()).
        const wasDisplayed = this.effectiveMissionId() === ev.missionId;
        // Any ended mission (complete/fail/abandon) leaves the active set, so the
        // picker matches what you actually have. COMPLETED also flags the badge.
        this.endedMissionIds.add(ev.missionId);
        // An ended mission can't stay pinned — the pin would keep its pool on screen.
        if (ev.missionId === this.selectedMissionId) this.selectedMissionId = null;
        if (ev.state.includes("COMPLETED")) {
          this.completedMissionIds.add(ev.missionId);
          if (wasDisplayed) this.beginCompletion(ev.missionId, this.missions.get(ev.missionId)?.title ?? null, ev.ts);
        } else if (ev.state.includes("ABANDON") && wasDisplayed) {
          // Brief "abandoned" card so the pool doesn't just vanish unexplained.
          this.beginCompletion(ev.missionId, this.missions.get(ev.missionId)?.title ?? null, ev.ts, "abandoned");
        }
        this.emit("change");
        break;
      }

      case "contractComplete": {
        // Friendlier completion signal (has the title); usually fires just before the
        // MissionEnded push. Take over the display only for the mission on screen now.
        if (ev.missionId) {
          const info = this.missions.get(ev.missionId) ?? {};
          if (ev.title && !info.title) info.title = ev.title;
          this.missions.set(ev.missionId, info);
          if (ev.missionId === this.effectiveMissionId()) this.beginCompletion(ev.missionId, ev.title, ev.ts);
        }
        break;
      }

      case "reward": {
        const t = ev.ts ? Date.parse(ev.ts) : Date.now();
        this.lastReward = { amount: ev.amount, atMs: Number.isFinite(t) ? t : Date.now() };
        // The award fires a beat AFTER the completion, so attach it to a live card
        // that hasn't captured its payout yet.
        if (this.completion && this.completion.aUEC == null && Math.abs(this.lastReward.atMs - this.completion.completedAtMs) <= REWARD_WINDOW_MS) {
          this.completion.aUEC = ev.amount;
          this.emit("change");
        }
        break;
      }
      case "blueprintReceived": {
        const isNew = !this.observed.has(ev.name);
        const dateChanged = this.noteReceiptTime(ev.name, ev.ts);
        if (isNew) this.observed.add(ev.name);
        if (isNew || dateChanged) {
          this.saveState();
          if (isNew) this.emit("collected", ev.name);
          this.emit("change");
        }
        break;
      }
      case "activeObjective":
        // Reserved for finer tracked-mission detection; markers already cover it.
        break;

      case "sessionStart":
      case "sessionEnd": {
        // Joined/re-entered the PU (or left it — quit to menu, disconnect, client
        // exit). Either way the previous shard's missions no longer apply (they're
        // not active here and SC won't log their end). Wipe the whole active set so
        // stale missions don't linger; it rebuilds from the next shard's markers.
        this.resetSession();
        this.emit("change");
        break;
      }
    }
  }

  /** Record the earliest in-game unlock time seen for a blueprint name. Returns true
   *  if it set or moved the stored time earlier. Ignores empty/unparseable stamps. */
  private noteReceiptTime(name: string, ts: string | null): boolean {
    if (!ts) return false;
    const t = Date.parse(ts);
    if (Number.isNaN(t)) return false;
    const prev = this.observedAt.get(name);
    if (prev && Date.parse(prev) <= t) return false;
    this.observedAt.set(name, ts);
    return true;
  }

  /** Start the brief "mission complete" hold-card for a just-completed mission.
   *  Idempotent (the same completion arrives via contractComplete AND MissionEnded)
   *  and gated to real-time completions so seeding from the log on startup doesn't
   *  pop a stale card. Correlates the aUEC award by log-time proximity. */
  private beginCompletion(
    missionId: string,
    title: string | null,
    ts: string | null,
    kind: "completed" | "abandoned" = "completed",
  ): void {
    const completedAtMs = ts ? Date.parse(ts) : Date.now();
    if (!Number.isFinite(completedAtMs)) return;
    const info = this.missions.get(missionId);
    const aUEC =
      kind === "completed" && this.lastReward && Math.abs(this.lastReward.atMs - completedAtMs) <= REWARD_WINDOW_MS
        ? this.lastReward.amount
        : null;
    // Record to the persisted recent-mission history for BOTH real-time and
    // startup-replayed completions (the summary card below stays gated to real-time).
    if (kind === "completed") {
      this.recordMissionComplete(missionId, title ?? info?.title ?? null, ts, aUEC);
    }
    if (Date.now() - completedAtMs > COMPLETION_FRESH_MS) return; // historical replay — no card
    if (this.completion && this.completion.missionId === missionId) {
      if (title && !this.completion.title) this.completion.title = title;
      return;
    }
    // Real-time completion (not startup replay, and past the idempotency guard so it
    // runs once): fold its rep gain into the giver's witnessed total for the rep bar.
    // The current session is always the current patch (post-4.8-wipe), so no window check.
    if (kind === "completed") this.accrueFromTitle(title ?? info?.title ?? null);
    const holdMs = kind === "abandoned" ? ABANDON_HOLD_MS : COMPLETION_HOLD_MS;
    this.completion = {
      missionId,
      title: title ?? info?.title ?? null,
      kind,
      completedAtMs,
      acceptedAtMs: info?.acceptedAt ?? null,
      aUEC,
      until: Date.now() + holdMs,
    };
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.completionTimer = setTimeout(() => {
      this.completion = null;
      this.completionTimer = null;
      this.emit("change"); // hold expired → overlay moves to the next mission
    }, holdMs);
    if (kind === "completed") this.saveState(); // persist the new recent-mission entry
    this.emit("change");
  }

  /** Blueprint names received during the completed mission (receipt time between its
   *  accept and completion) — the "+N blueprints" line on the completion card. */
  private completionBlueprints(): BlueprintReward[] {
    const c = this.completion;
    if (!c) return [];
    const lo = c.acceptedAtMs ?? -Infinity;
    const hi = c.completedAtMs + REWARD_WINDOW_MS;
    const out: BlueprintReward[] = [];
    for (const [name, ts] of this.observedAt) {
      const t = Date.parse(ts);
      if (Number.isFinite(t) && t >= lo && t <= hi) out.push(this.blueprintReward(name));
    }
    return out;
  }

  /** Resolve a received blueprint name to its item UUID + site render URL for display. */
  private blueprintReward(name: string): BlueprintReward {
    const item = this.itemUuidsForName(name)[0] ?? null;
    const base = this.remoteBaseUrl ?? "https://subliminal.gg/sc";
    return { name, item, image: item ? `${base}/items/${item}.webp` : null };
  }

  /** Record a completed mission into the capped, newest-first history (deduped by
   *  missionId + completion time). Used by BOTH live completions and log backfill,
   *  so it must be independent of the freshness gate that governs the on-screen card. */
  private recordMissionComplete(missionId: string | null, title: string | null, ts: string | null, aUEC: number | null): void {
    if (!ts) return;
    const parsed = Date.parse(ts);
    if (!Number.isFinite(parsed)) return;
    const at = new Date(parsed).toISOString();
    const dupe = this.missionHistory.find((m) => m.at === at && (m.missionId ?? null) === (missionId ?? null));
    if (dupe) {
      // A second source (contractComplete vs reward correlation) may enrich a partial.
      if (title && !dupe.title) dupe.title = title;
      if (aUEC != null && dupe.aUEC == null) dupe.aUEC = aUEC;
      return;
    }
    this.missionHistory.push({ missionId: missionId ?? null, title: title ?? null, aUEC, at });
    this.missionHistory.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    if (this.missionHistory.length > MISSION_HISTORY_MAX) this.missionHistory.length = MISSION_HISTORY_MAX;
  }

  private recentMissions(n = 5): RecentMission[] {
    return this.missionHistory.slice(0, n).map((m) => ({ title: m.title, aUEC: m.aUEC, at: m.at }));
  }

  private recentBlueprints(n = 5): RecentBlueprint[] {
    return [...this.observedAt.entries()]
      .filter(([, ts]) => Number.isFinite(Date.parse(ts)))
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
      .slice(0, n)
      .map(([name, at]) => ({ name, at }));
  }

  /** Re-scan a set of log files for `Received Blueprint` receipts and fold them into
   *  the collected set. Recovers history from rotated logbackups AND undoes accidental
   *  un-ticks (a not-owned override is cleared when the logs prove the blueprint was
   *  received). Read sequentially — backups can be tens of MB.
   *  ONLY counts PUB (live) sessions — PTU/EPTU/TECH-PREVIEW progress is on a
   *  separate account and must not pollute your live collection. Blueprints are NOT
   *  wiped between patches, so all live patches count. */
  verifyFromLogs(paths: string[]): { files: number; receipts: number; added: number; restored: number; skipped: number; unresolved: string[] } {
    // name -> earliest receipt timestamp across all scanned logs (backups carry the
    // real historical unlock times, so this also backfills dates for names already
    // observed without one).
    const receiptTimes = new Map<string, string | null>();
    // Completed missions + aUEC awards harvested for the recent-mission backfill,
    // correlated by log-time proximity after the scan (a "reward" line's own
    // MissionId is all-zeros, same as the live path).
    const completions: { missionId: string | null; title: string | null; ts: string; tsMs: number; inWindow: boolean }[] = [];
    const rewards: { tsMs: number; amount: number }[] = [];
    let files = 0;
    let receipts = 0;
    let skipped = 0;
    for (const p of paths) {
      let text: string;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      // Environment tag lives in the header (--envtag='PUB' / Environment: PUB).
      // Anything not PUB is a test environment — skip it.
      const env = /--envtag=.?([A-Za-z0-9_]+)|Environment:\s*([A-Za-z0-9_]+)/.exec(text.slice(0, 4000));
      const tag = (env?.[1] || env?.[2] || "").toUpperCase();
      if (tag && tag !== "PUB") {
        skipped++;
        continue;
      }
      // Version family (major.minor) from the header — the 4.8 wipe means only 4.8+
      // completions count toward the rep bar (blueprints are unaffected, so they still
      // count from every PUB log regardless of family).
      const famM = /(?:Product|File)Version:\s*(\d+\.\d+)/.exec(text.slice(0, 4000));
      const inWindow = familyAtLeast48(famM?.[1] ?? null);
      files++;
      for (const line of text.split(/\r?\n/)) {
        // Cheap prefilter: blueprint receipts, contract completions, awards — plus the
        // mission markers/accepts we mine for rank inference.
        if (!line.includes("Received Blueprint:") && !line.includes("Contract Complete:") && !line.includes("Awarded ")
          && !line.includes("CreateMarker") && !line.includes("Contract Accepted:")) continue;
        const ev = parseMissionEvent(parseLine(line));
        if (!ev) continue;
        // Rank backfill: being OFFERED a rank-N mission proves standing >= N with its
        // giver. Nearly all that history is in the BACKUPS — the live log only covers
        // today's session — so this scan is the only way to learn a rank you earned
        // before the tracker was watching. (Actual rep is server-side, never logged.)
        // Deliberately does NOT touch this.missions: historical missions must not leak
        // into the picker or the tracked-mission state.
        if (ev.kind === "marker") {
          this.noteRankForKey(ev.contractKey);
          continue;
        }
        if (ev.kind === "accept") {
          const res = ev.title ? this.resolveAcceptTitle(ev.title) : null;
          if (res) this.noteRankForKey(res.keys[0]);
          continue;
        }
        if (ev.kind === "blueprintReceived") {
          receipts++;
          const prev = receiptTimes.get(ev.name);
          // Keep the earliest parseable stamp; ensure the name is present even if the
          // stamp is missing (so it still counts toward observed).
          if (ev.ts && (prev == null || (prev !== undefined && Date.parse(ev.ts) < Date.parse(prev)))) {
            receiptTimes.set(ev.name, ev.ts);
          } else if (!receiptTimes.has(ev.name)) {
            receiptTimes.set(ev.name, ev.ts ?? null);
          }
        } else if (ev.kind === "contractComplete" && ev.ts && Number.isFinite(Date.parse(ev.ts))) {
          completions.push({ missionId: ev.missionId, title: ev.title, ts: ev.ts, tsMs: Date.parse(ev.ts), inWindow });
        } else if (ev.kind === "reward" && ev.ts && Number.isFinite(Date.parse(ev.ts))) {
          rewards.push({ tsMs: Date.parse(ev.ts), amount: ev.amount });
        }
      }
    }
    let added = 0;
    for (const [n, ts] of receiptTimes) {
      if (!this.observed.has(n)) {
        this.observed.add(n);
        added++;
      }
      this.noteReceiptTime(n, ts); // backfill / refine the unlock date
    }
    // Clear any not-owned override the logs contradict — recovers accidental un-ticks.
    let restored = 0;
    for (const [name, val] of [...this.overrides]) {
      if (val === false && matchesPoolName(name, receiptTimes.keys())) {
        this.overrides.delete(name);
        restored++;
      }
    }
    // Fold harvested completions into the recent-mission history, each correlated to
    // the nearest aUEC award within the reward window (like the live path).
    for (const c of completions) {
      let amount: number | null = null;
      let bestDist = REWARD_WINDOW_MS;
      for (const r of rewards) {
        const d = Math.abs(r.tsMs - c.tsMs);
        if (d <= bestDist) { bestDist = d; amount = r.amount; }
      }
      this.recordMissionComplete(c.missionId, c.title, c.ts, amount);
    }
    // Rebuild the witnessed-rep totals authoritatively from every in-window completion.
    // Rebuilt (not incremented) so a re-verify can't double-count; only 4.8+ completions
    // count (the wipe reset earlier rep). Resolves each completion by title via the
    // comprehensive rep-title index (covers non-pool missions too).
    this.repWitnessed.clear();
    for (const c of completions) {
      if (c.inWindow) this.accrueFromTitle(c.title);
    }
    this.saveState();
    this.emit("change");
    // Diagnostic: receipts we witnessed but couldn't tie to a dataset item (so they
    // count as collected but can't sync or show owned). With the global `index` these
    // should be empty; a non-empty list flags a data gap (a blueprint missing from the
    // mirror) worth regenerating the dataset for. Only meaningful once a dataset loaded.
    const unresolved = this.dataset
      ? [...receiptTimes.keys()].filter((n) => this.itemUuidsForName(n).length === 0).sort()
      : [];
    if (unresolved.length) {
      console.warn(`[verify] ${unresolved.length} received blueprint(s) not in the dataset:`, unresolved);
    }
    return { files, receipts, added, restored, skipped, unresolved };
  }

  /** Manual owned/not-owned override (seeds pre-existing inventory the log can't see). */
  setOwned(blueprintName: string, owned: boolean): void {
    this.overrides.set(blueprintName, owned);
    this.saveState();
    this.emit("change");
  }

  /** Tick a guaranteed ITEM reward (jumpsuit/hat/etc.) as acquired. Manual-only — item
   *  awards never appear in the log — and tracked apart from blueprints so it can't
   *  affect the collected count or the site sync. */
  setGuaranteedOwned(itemName: string, owned: boolean): void {
    if (owned) this.guaranteedOwned.add(itemName);
    else this.guaranteedOwned.delete(itemName);
    this.saveState();
    this.emit("change");
  }

  /** Clear the per-shard active-mission state (markers, ended/completed flags, the
   *  tracked/selected pointers). Keeps the collected blueprints — those are account-
   *  wide. Used on PU (re)entry and the manual "Refresh from log". */
  resetSession(): void {
    this.markerSeq = [];
    this.acceptedSeq = [];
    this.trackedMissionId = null;
    this.selectedMissionId = null;
    this.markerSinceJoin = false;
    this.endedMissionIds.clear();
    this.completedMissionIds.clear();
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.completionTimer = null;
    this.completion = null;
  }

  /** Pin the overlay to a specific accepted mission (from the picker), or null to
   *  auto-follow. The log can't tell us which mission you've selected to track, so
   *  this is the manual escape hatch. */
  selectMission(missionId: string | null): void {
    this.selectedMissionId = missionId && this.missions.has(missionId) ? missionId : null;
    this.emit("change");
  }

  /** Feed the mission title the screen OCR reads as PINNED in-game. Matched (normalized,
   *  exact) against known accepted missions; on a match it becomes the auto-follow target
   *  (a manual pick still wins). Returns whether it matched something. No-op on no match,
   *  so a misread never clears a good state. */
  setScreenMission(title: string): boolean {
    // Match tolerantly (truncation / OCR glitches) but tie-safe — a misread that doesn't
    // uniquely resolve is a no-op, so it can never clobber a good state. See matchScreenTitle.
    const candidates = [...this.missions]
      .filter(([id, info]) => info.title && !this.endedMissionIds.has(id))
      .map(([id, info]) => ({ id, title: info.title! }));
    let matched = matchScreenTitle(title, candidates);
    // Recovery: if the pinned mission isn't among known missions — Alt-F4 → relaunch
    // rotates game.log so the accept is gone, and a session reset cleared the picker —
    // resolve the OCR'd title straight from the dataset and re-register it. OCR reads the
    // CURRENT screen, so this can only ever surface a mission you're actually on now.
    if (!matched) {
      const res = this.resolveAcceptTitle(title);
      const key = res?.keys[0];
      if (key) {
        const existing = [...this.missions].find(([id, info]) => info.contractKey === key && !this.endedMissionIds.has(id));
        if (existing) matched = existing[0];
        else {
          matched = "ocr:" + key;
          this.missions.set(matched, { title, contractKey: key, acceptKeys: res!.keys, ambiguous: res!.ambiguous, acceptedAt: Date.now() });
        }
      }
    }
    if (!matched) return false;
    // A confirmed on-screen mission is as strong a "current mission exists" signal as a
    // marker — clear the post-reset suppression so effectiveMissionId can surface it, and
    // put it back in the picker.
    this.endedMissionIds.delete(matched);
    if (!this.acceptedSeq.includes(matched) && !this.markerSeq.includes(matched)) this.acceptedSeq.push(matched);
    this.markerSinceJoin = true;
    if (this.screenMissionId !== matched) {
      this.screenMissionId = matched;
    }
    this.emit("change");
    return true;
  }

  /** Dataset entry for a mission id, or undefined. Since schema/2 the missions map
   *  also holds pool-LESS missions that carry a payout or item rewards. */
  private datasetMission(missionId: string): DatasetMission | undefined {
    const key = this.missions.get(missionId)?.contractKey;
    return key ? this.dataset?.missions[key] : undefined;
  }

  /** Infer standing with a giver from a resolved mission: the game only OFFERS a ranked
   *  mission once you've reached that rank, so accepting one proves you're at least
   *  there. Keeps the highest ever seen — a lower bound, since actual rep is a
   *  server-side service the log never carries. Rank-less (intro/story) missions prove
   *  nothing and are ignored. */
  private noteRank(missionId: string): void {
    const key = this.missions.get(missionId)?.contractKey;
    if (key && this.noteRankForKey(key)) {
      this.saveState();
      this.emit("change");
    }
  }

  /** Raise a giver's inferred rank from a dataset mission key. Returns true when it
   *  actually moved, so a batch scan (verifyFromLogs over hundreds of backups) can
   *  persist/emit once at the end instead of per line. */
  private noteRankForKey(debugName: string): boolean {
    const m = this.dataset?.missions[debugName];
    const giver = m?.giver;
    const rank = m?.rank;
    if (!giver || typeof rank !== "number") return false;
    const prev = this.inferredRank.get(giver);
    if (prev != null && prev >= rank) return false;
    this.inferredRank.set(giver, rank);
    return true;
  }

  // ---- reputation progress bar ----

  /** The primary, mobiGlas-facing rep entry a mission grants: an org-scope gain (in
   *  rep-scopes.json, not an internal modifier), picked by scope priority then amount.
   *  null when the mission grants no rankable rep (intro/story/pure-item missions). */
  private primaryRep(m: DatasetMission | undefined): { scope: string; faction: string; amount: number } | null {
    const rankOf = (s: string) => {
      const i = REP_SCOPE_PRIORITY.indexOf(s);
      return i < 0 ? REP_SCOPE_PRIORITY.length : i;
    };
    const entries = (m?.reputationGained ?? []).filter(
      (r) => r.amount > 0 && this.repScopes[r.scope] && !REP_SCOPE_DENY.test(r.scope),
    );
    if (entries.length === 0) return null;
    entries.sort((a, b) => rankOf(a.scope) - rankOf(b.scope) || b.amount - a.amount);
    const e = entries[0];
    return { scope: e.scope, faction: e.faction, amount: e.amount };
  }

  /** Index EVERY dataset mission's title -> the primary rep gain to credit on completion,
   *  so combat/patrol/delivery completions (no blueprint pool) still feed the rep bar.
   *  Ambiguous titles (same title, different giver/scope) map to null and are skipped;
   *  same-org difficulty tiers collapse to the MIN amount (conservative under-count). */
  private buildRepTitleIndex(): void {
    this.repTitleIndex.clear();
    if (!this.dataset) return;
    for (const m of Object.values(this.dataset.missions)) {
      if (!m.title || !m.giver) continue;
      const pr = this.primaryRep(m);
      if (!pr) continue;
      const k = normScreenTitle(m.title);
      if (!k) continue;
      const entry = { giver: m.giver, scope: pr.scope, amount: pr.amount };
      if (!this.repTitleIndex.has(k)) { this.repTitleIndex.set(k, entry); continue; }
      const cur = this.repTitleIndex.get(k);
      if (cur == null) continue; // already flagged ambiguous
      if (cur.giver !== entry.giver || cur.scope !== entry.scope) this.repTitleIndex.set(k, null);
      else if (entry.amount < cur.amount) cur.amount = entry.amount;
    }
  }

  /** Credit a completed mission's rep to its giver's witnessed total, resolved from the
   *  completion TITLE via the comprehensive rep-title index. Keyed by GIVER (matching how
   *  computeRepBar looks it up). NOT idempotent — callers gate to genuinely-new completions
   *  (a real-time completion, or a from-scratch verifyFromLogs rebuild) so nothing is
   *  double-counted. Unknown/ambiguous titles are skipped. */
  private accrueFromTitle(title: string | null | undefined): void {
    if (!title) return;
    const e = this.repTitleIndex.get(normScreenTitle(title));
    if (!e) return;
    const cur = this.repWitnessed.get(e.giver);
    if (cur && cur.scope === e.scope) cur.sum += e.amount;
    else this.repWitnessed.set(e.giver, { scope: e.scope, sum: (cur?.sum ?? 0) + e.amount });
  }

  /** Build the rep progress bar for the tracked mission's giver: estimate = max(inferred-
   *  rank floor, witnessed post-4.8 gains), placed on the scope's ladder. A lower bound —
   *  reads low until a higher-rank mission is offered (raising the floor) and re-anchors. */
  private computeRepBar(m: DatasetMission | undefined): RepBar | null {
    const giver = m?.giver;
    if (!giver) return null;
    const primary = this.primaryRep(m);
    if (!primary) return null;
    const pos = repLadderPosition(this.repScopes[primary.scope], this.repWitnessed.get(giver)?.sum ?? 0);
    if (!pos) return null;
    return { scope: primary.scope, faction: giver, ...pos };
  }

  /** Index pooled, titled missions by normalized title so a marker-less accept can
   *  resolve its pool from the friendly title alone. Pool-less/untitled missions are
   *  skipped (a title with no pool can't help, and would only add noise). */
  private buildTitleIndex(): void {
    this.titleIndex.clear();
    if (!this.dataset) return;
    for (const [debugName, m] of Object.entries(this.dataset.missions)) {
      if (!m.title || Object.keys(m.pools ?? {}).length === 0) continue;
      const k = normScreenTitle(m.title);
      if (!k) continue;
      const arr = this.titleIndex.get(k);
      if (arr) arr.push(debugName);
      else this.titleIndex.set(k, [debugName]);
    }
  }

  /** Resolve an accept-notification title to the dataset debug_name(s) that share it.
   *  `ambiguous` is true when those missions have DIFFERENT pools (e.g. "Ore Scan
   *  Needed" has two tiers with distinct rewards) — the caller merges + labels them.
   *  Same-title-same-pool variants resolve to an equivalent representative. */
  private resolveAcceptTitle(title: string): { keys: string[]; ambiguous: boolean } | null {
    const k = normScreenTitle(title);
    if (!k || !this.dataset) return null;
    const keys = this.titleIndex.get(k);
    if (!keys || keys.length === 0) return null;
    const poolSig = (dn: string) => Object.keys(this.dataset!.missions[dn]?.pools ?? {}).sort().join(",");
    const distinct = new Set(keys.map(poolSig));
    return { keys, ambiguous: distinct.size > 1 };
  }

  /** Resolve accepts that were registered before the dataset was ready (cold start
   *  replays the log before the async dataset fetch lands). Keeps only accepts whose
   *  title maps to a pool; drops pool-less/unknown ones. acceptedSeq is shard-scoped
   *  (resetSession clears it), so this only ever touches the current shard's missions. */
  private reresolveAccepts(): void {
    if (!this.dataset) return;
    const keep: string[] = [];
    for (const missionId of this.acceptedSeq) {
      const info = this.missions.get(missionId);
      if (!info) continue;
      if (info.acceptKeys || info.contractKey) { keep.push(missionId); continue; } // already resolved
      const res = info.title ? this.resolveAcceptTitle(info.title) : null;
      if (res) {
        info.contractKey = res.keys[0];
        info.acceptKeys = res.keys;
        info.ambiguous = res.ambiguous;
        this.markerSinceJoin = true;
        this.noteRank(missionId);
        keep.push(missionId);
      }
    }
    this.acceptedSeq = keep;
  }

  /** Union the pools of several missions (dedup blueprints within a pool by name) —
   *  used only for an ambiguous marker-less mission so the player sees every possible
   *  drop. Odds are approximate (the real instance draws from one tier). */
  private mergePools(keys: string[]): Record<string, PoolEntry[]> {
    const out: Record<string, PoolEntry[]> = {};
    if (!this.dataset) return out;
    for (const dn of keys) {
      const m = this.dataset.missions[dn];
      for (const [poolUuid, entries] of Object.entries(m?.pools ?? {})) {
        const existing = out[poolUuid] ?? (out[poolUuid] = []);
        const seen = new Set(existing.map((e) => e.blueprint));
        for (const e of entries) if (!seen.has(e.blueprint)) existing.push(e);
      }
    }
    return out;
  }

  private missionHasPool(missionId: string): boolean {
    const m = this.datasetMission(missionId);
    return !!m && Object.keys(m.pools ?? {}).length > 0;
  }

  /** Has something to show: a blueprint pool, a payout / item-reward readout, OR a
   *  dynamic-event reward ladder (XenoThreat). Lets the mission you're actively on
   *  display its info instead of falling behind an older pooled mission. */
  private missionHasContent(missionId: string): boolean {
    if (this.missionHasPool(missionId)) return true;
    const m = this.datasetMission(missionId);
    if (m && (m.payout || (m.items?.length ?? 0) > 0)) return true;
    const info = this.missions.get(missionId);
    return isXenoThreatMission(info?.contractKey ?? null, info?.generator ?? null);
  }

  /** The mission whose pool to show: the manual pick if set; otherwise the newest
   *  accepted mission that has a pool (so a cargo haul accepted after a blueprint
   *  mission doesn't hide it); falling back to the newest of all. */
  private effectiveMissionId(): string | null {
    const active = (id: string) => !this.endedMissionIds.has(id);
    if (this.selectedMissionId && this.missions.has(this.selectedMissionId) && active(this.selectedMissionId)) {
      return this.selectedMissionId;
    }
    // After a fresh PU entry with no marker yet, show nothing rather than a mission
    // carried over from the previous shard. The picker still lets you choose one.
    if (!this.markerSinceJoin) return null;
    // Ground truth from the screen OCR: the mission the player has PINNED in-game (the
    // log can't say which accepted mission is tracked). Beats the marker-order guess
    // below, but never a manual pick above.
    if (this.screenMissionId && this.missions.has(this.screenMissionId) && active(this.screenMissionId) && this.missionHasContent(this.screenMissionId)) {
      return this.screenMissionId;
    }
    if (this.trackedMissionId && active(this.trackedMissionId) && this.missionHasContent(this.trackedMissionId)) {
      return this.trackedMissionId;
    }
    for (let i = this.markerSeq.length - 1; i >= 0; i--) {
      if (active(this.markerSeq[i]) && this.missionHasPool(this.markerSeq[i])) return this.markerSeq[i];
    }
    for (let i = this.markerSeq.length - 1; i >= 0; i--) {
      if (active(this.markerSeq[i])) return this.markerSeq[i];
    }
    // No marker-based mission to show — fall back to the newest marker-LESS mission we
    // resolved from its accept title (mining/scan). Markered missions always win above.
    for (let i = this.acceptedSeq.length - 1; i >= 0; i--) {
      if (active(this.acceptedSeq[i]) && this.missionHasContent(this.acceptedSeq[i])) return this.acceptedSeq[i];
    }
    // Nothing active — e.g. the LAST mission was just abandoned/completed. Show
    // nothing rather than the tracked-but-ended mission (which used to stick on
    // screen forever after abandoning your only mission).
    return this.trackedMissionId && active(this.trackedMissionId) ? this.trackedMissionId : null;
  }

  /** Active missions (ended ones excluded), newest first — for the overlay picker. */
  private knownMissions(): TrackedView["missions"] {
    // Marker-based AND accept-resolved (marker-less) missions, deduped, newest first.
    const ids = [...new Set([...this.markerSeq, ...this.acceptedSeq])].filter((id) => !this.endedMissionIds.has(id));
    ids.sort((a, b) => (this.missions.get(b)?.acceptedAt ?? 0) - (this.missions.get(a)?.acceptedAt ?? 0));
    return ids.map((id) => {
      const info = this.missions.get(id);
      const key = info?.contractKey ?? null;
      const title = info?.title || (key && this.dataset?.missions[key]?.title) || key || id;
      return { id, title, contractKey: key, hasPool: this.missionHasPool(id) };
    });
  }

  // ---- ownership resolution ----

  private isOwned(poolName: string): { owned: boolean; source: BlueprintSource } {
    // Explicit manual override on the exact pool name wins (owned or not-owned).
    if (this.overrides.has(poolName)) {
      const v = this.overrides.get(poolName)!;
      return { owned: v, source: v ? "manual" : null };
    }
    // Earned in-game (an observed receipt, incl. a variant) — most specific.
    if (matchesPoolName(poolName, this.observed)) return { owned: true, source: "in-game" };
    // A manual override on a variant name.
    for (const [name, val] of this.overrides) {
      if (val && matchesPoolName(poolName, [name])) return { owned: true, source: "manual" };
    }
    // Starter gear owned by default (never appears in the log); from the dataset.
    if (this.dataset?.defaults?.some((d) => matchesPoolName(poolName, [d.name]))) return { owned: true, source: "default" };
    return { owned: false, source: null };
  }

  // ---- subliminal.gg sync helpers ----
  // The site collection is keyed by output item UUID; the log only yields names,
  // so map names → UUIDs through the dataset (variant-aware, same as ownership).

  /** Resolve a normalized name against a set of {name,item} entries. Precise on
   *  purpose — a loose bidirectional prefix match once fanned one receipt out to many
   *  items and inflated the synced collection. An EXACT name match wins; otherwise the
   *  target is treated as a variant ("Geist Armor Arms Whiteout") of the LONGEST base
   *  name that prefixes it ("Geist Armor Arms"). No reverse (base→all-variants) match. */
  private resolveName(target: string, entries: Iterable<{ name: string; item: string | null }>): string[] {
    const exact = new Set<string>();
    let bestBase = "";
    const baseItems = new Set<string>();
    for (const e of entries) {
      if (!e.item) continue;
      const p = norm(e.name);
      if (p === target) {
        exact.add(e.item);
      } else if (target.startsWith(p + " ")) {
        if (p.length > bestBase.length) {
          bestBase = p;
          baseItems.clear();
          baseItems.add(e.item);
        } else if (p === bestBase) {
          baseItems.add(e.item);
        }
      }
    }
    return exact.size ? [...exact] : [...baseItems];
  }

  /** Item UUID(s) for a received blueprint name. Resolved over mission pools AND the
   *  global blueprint `index` TOGETHER so that an EXACT match always beats a prefix
   *  match, regardless of which set it came from. This matters for camo/variant items:
   *  "Testudo Arms Purgatory Camo" has its own exact entry in the index, but a mission
   *  pool also carries the base "Testudo Arms" — resolving pools first would prefix-match
   *  the base and sync the WRONG item's UUID. Combining lets the exact variant win; only
   *  a variant with no exact entry anywhere falls back to its longest base prefix. */
  itemUuidsForName(received: string): string[] {
    if (!this.dataset) return [];
    const entries: { name: string; item: string | null }[] = [];
    for (const mission of Object.values(this.dataset.missions))
      for (const pool of Object.values(mission.pools))
        for (const e of pool) entries.push({ name: e.blueprint, item: e.item });
    if (this.dataset.index) for (const e of this.dataset.index) entries.push({ name: e.name, item: e.item });
    const direct = this.resolveName(norm(received), entries);
    if (direct.length) return direct;
    // Fallback: SC ship-component designation ("Mil/2/B Bolide", `STL-1B "Zephyr"`) →
    // the bare model the dataset stores ("Bolide", "Zephyr").
    const model = componentModel(received);
    return model ? this.resolveName(norm(model), entries) : [];
  }

  /** Every collected blueprint (observed + owned-overrides) as item UUIDs. */
  collectedItemUuids(): string[] {
    const out = new Set<string>();
    for (const name of this.observed) for (const u of this.itemUuidsForName(name)) out.add(u);
    for (const [name, val] of this.overrides) {
      if (val) for (const u of this.itemUuidsForName(name)) out.add(u);
    }
    return [...out];
  }

  /** Every collected blueprint as { uuid, unlockedAt } for the site sync. The date is
   *  the earliest in-game receipt time among the names mapping to that UUID; null for
   *  manual overrides and receipts logged before unlock-time tracking existed (the
   *  site falls back to when it first recorded the blueprint). */
  collectedItemsWithDates(): { uuid: string; unlockedAt: string | null; source: "in-game" | "manual" | "default" }[] {
    const RANK = { default: 1, manual: 2, "in-game": 3 } as const;
    const map = new Map<string, { unlockedAt: string | null; source: "in-game" | "manual" | "default" }>();
    const consider = (uuid: string, ts: string | null, source: "in-game" | "manual" | "default") => {
      const cur = map.get(uuid);
      if (!cur) {
        map.set(uuid, { unlockedAt: ts, source });
        return;
      }
      // Keep the strongest source (in-game > manual > default) + earliest unlock time.
      if (RANK[source] > RANK[cur.source]) cur.source = source;
      if (ts && (cur.unlockedAt == null || Date.parse(ts) < Date.parse(cur.unlockedAt))) cur.unlockedAt = ts;
    };
    // Add low→high so a stronger source upgrades the same uuid (defaults first).
    for (const d of this.dataset?.defaults ?? []) if (d.item) consider(d.item, null, "default");
    for (const [name, val] of this.overrides) {
      if (val) for (const u of this.itemUuidsForName(name)) consider(u, null, "manual");
    }
    for (const name of this.observed) {
      const ts = this.observedAt.get(name) ?? null;
      for (const u of this.itemUuidsForName(name)) consider(u, ts, "in-game");
    }
    return [...map].map(([uuid, v]) => ({ uuid, unlockedAt: v.unlockedAt, source: v.source }));
  }

  /** The tracked mission's dataset key (debug_name), or null. */
  currentContractKey(): string | null {
    const t = this.trackedMissionId ? this.missions.get(this.trackedMissionId) : undefined;
    return t?.contractKey ?? null;
  }

  /** The detected build changelist (or the loaded dataset's), or null. */
  currentChangelist(): string | null {
    return this.detectedChangelist ?? this.dataset?.changelist ?? null;
  }

  // ---- view for the overlay ----

  view(): TrackedView {
    // While the completion card is up, keep the just-completed mission on screen
    // (it's already in endedMissionIds, so effectiveMissionId() has moved on).
    const holdActive = !!this.completion && Date.now() < this.completion.until;
    const effectiveId = holdActive ? this.completion!.missionId : this.effectiveMissionId();
    const tracked = effectiveId ? this.missions.get(effectiveId) : undefined;
    const key = tracked?.contractKey ?? null;
    const mission = key && this.dataset ? this.dataset.missions[key] : undefined;
    // Ambiguous marker-less mission (title maps to variants with different pools):
    // show the union of every candidate's pools so no possible drop is hidden. Odds are
    // approximate — the real instance draws one tier — hence the `ambiguous` banner.
    const ambiguous = !!tracked?.ambiguous && !!tracked?.acceptKeys;
    const effectivePools = ambiguous ? this.mergePools(tracked!.acceptKeys!) : (mission?.pools ?? {});

    const pools: TrackedView["pools"] = [];
    let owned = 0;
    let total = 0;
    if (mission || ambiguous) {
      for (const [poolUuid, entries] of Object.entries(effectivePools)) {
        const blueprints: BlueprintStatus[] = entries.map((e) => {
          const o = this.isOwned(e.blueprint);
          if (o.owned) owned++;
          total++;
          const cat = categorize(e);
          return { name: e.blueprint, owned: o.owned, source: o.source, chance: e.chance, tab: cat.tab, sub: cat.sub };
        });
        pools.push({ poolUuid, blueprints });
      }
    }

    // XenoThreat (and other pool-less event missions): show the personal reward
    // ladder instead of "no blueprint reward". Owned status matches by name via the
    // observed set (the log's "Received Blueprint" lines). Keyed off pool CONTENT —
    // since schema/2 an event mission can have a (pool-less) dataset entry.
    let eventTrack: EventTrack | null = null;
    if (pools.length === 0 && isXenoThreatMission(key, tracked?.generator ?? null)) {
      eventTrack = {
        name: "Return of XenoThreat",
        note: XENOTHREAT_NOTE,
        tiers: XENOTHREAT_TIERS.map((t) => ({
          pct: t.pct,
          items: t.items.map((name) => {
            const o = this.isOwned(name);
            return { name, owned: o.owned, source: o.source };
          }),
        })),
      };
    }

    return {
      patch: this.patch,
      build: this.detectedChangelist,
      contractKey: key,
      title: mission?.title ?? tracked?.title ?? null,
      generator: tracked?.generator ?? mission?.generatorClass ?? null,
      hasPool: pools.length > 0,
      ambiguous,
      payout: mission?.payout ?? null,
      itemRewards: (mission?.items ?? []).map((i) => ({
        name: i.name,
        amount: Number(i.amount) || 1,
        owned: this.guaranteedOwned.has(i.name),
      })),
      giver: mission?.giver ?? null,
      inferredRank: mission?.giver ? this.inferredRank.get(mission.giver) ?? null : null,
      repBar: this.computeRepBar(mission),
      missionType: mission?.missionType ?? null,
      reputationGained: mission?.reputationGained ?? [],
      reputationLost: mission?.reputationLost ?? [],
      eventTrack,
      completed:
        (holdActive && this.completion!.kind === "completed") ||
        (effectiveId ? this.completedMissionIds.has(effectiveId) : false),
      pools,
      totals: { owned, total },
      collectedTotal: this.observed.size + [...this.overrides.values()].filter(Boolean).length,
      recentMissions: this.recentMissions(),
      recentBlueprints: this.recentBlueprints(),
      completion: holdActive
        ? {
            title: this.completion!.title ?? mission?.title ?? tracked?.title ?? null,
            kind: this.completion!.kind,
            aUEC: this.completion!.aUEC,
            durationMs: this.completion!.acceptedAtMs != null ? this.completion!.completedAtMs - this.completion!.acceptedAtMs : null,
            blueprints: this.completion!.kind === "completed" ? this.completionBlueprints() : [],
          }
        : null,
      selectedId: this.selectedMissionId,
      missions: this.knownMissions(),
    };
  }

  // ---- persistence ----

  private loadState(): void {
    try {
      const data = JSON.parse(readFileSync(this.statePath, "utf8")) as Persisted;
      this.observed = new Set(data.observed ?? []);
      this.observedAt = new Map(Object.entries(data.observedAt ?? {}));
      this.overrides = new Map(Object.entries(data.overrides ?? {}));
      this.guaranteedOwned = new Set(data.guaranteedOwned ?? []);
      this.inferredRank = new Map(Object.entries(data.inferredRank ?? {}));
      this.repWitnessed = new Map(Object.entries(data.repWitnessed ?? {}));
      this.missionHistory = (data.missionHistory ?? []).slice(0, MISSION_HISTORY_MAX);
    } catch {
      /* first run */
    }
  }

  private saveState(): void {
    const data: Persisted = {
      observed: [...this.observed],
      overrides: Object.fromEntries(this.overrides),
      guaranteedOwned: [...this.guaranteedOwned],
      inferredRank: Object.fromEntries(this.inferredRank),
      repWitnessed: Object.fromEntries(this.repWitnessed),
      observedAt: Object.fromEntries(this.observedAt),
      missionHistory: this.missionHistory,
    };
    try {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true });
      const tmp = this.statePath + ".tmp";
      writeFileSync(tmp, JSON.stringify(data, null, 2));
      renameSync(tmp, this.statePath);
    } catch {
      /* non-fatal */
    }
  }
}
