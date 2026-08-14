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
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { parseMissionEvent, contractKeyOf, type MissionEvent } from "./missions-parser.js";
import { classifyMission, type CombatProfile, type MissionActivity } from "./mission-classify.js";
import { categorize, type TabKey } from "./categories.js";
import { parseLine } from "./parser.js";
import { BlueprintDetailStore, type BlueprintDetail } from "./blueprint-detail.js";
import type { SyncSource } from "./sync.js";

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
/** A started-but-unfinished blueprint pool, for the idle panel's "closest to done" list. */
export interface ClosestPool {
  key: string;
  title: string;
  owned: number;
  total: number;
  places: string[];
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
  /** Where the next rank sits on the ascending ladder — the index rank-gated rewards are keyed
   *  by, so the panel can say what reaching it actually unlocks. */
  nextRank: number | null;
  /** What the next rank hands over, if anything (Battaglia gates SHIPS this way: Golem at 3,
   *  Prospector at 4, MOLE at 5). The Event Tracker widget has always shown these; the panel —
   *  where you actually spend your time — only ever showed a number with no reason to care. */
  nextRewards: string[];
  /** True at the top of the ladder (no next rank). */
  max: boolean;
  /** No completions witnessed yet for this giver (run Verify from logs) — the UI shows an
   *  empty "estimate unavailable" state instead of a misleading zero-progress bar. */
  noData: boolean;
}
/** One mission on a giver's grind track, as the Battaglia widget lists them. */
export interface GrindMission {
  key: string;
  title: string;
  /** Standing tier the giver requires before offering it (dataset `rank`), or null for intros. */
  rank: number | null;
  /** Rep this mission awards toward the giver's standing. */
  rep: number;
  /** How many times this mission has been COMPLETED (0 = never). The only honest signal that
   *  its guaranteed items were actually received — the log never reports the items themselves. */
  completed: number;
  /** True when the count came from a TITLE match with no contract-key confirmation — another
   *  mission shares this title, so "received" is a best guess rather than a fact. */
  byTitleOnly: boolean;
  /** Blueprints in its reward pool (a random one drops). */
  poolCount: number;
  /** Guaranteed physical items — ships and gear the log NEVER reports, so they're the reason
   *  to chase a specific rank. */
  items: { name: string; amount: number }[];
}

/** A mission giver's whole reputation track: the standing ladder, where you are on it, and
 *  what each rank unlocks. Built for the Battaglia widget but keyed by giver, so it retires
 *  by changing one constant rather than deleting a feature. */
export interface GrindTrack {
  faction: string;
  scope: string;
  /** Current standing (same witnessed-only estimate the mission drawer's rep bar uses). */
  bar: RepBar | null;
  ranks: { rank: number; name: string; minRep: number; missions: GrindMission[] }[];
  /** Highest rank whose mission the giver has actually OFFERED you (from inferredRank — an
   *  observed fact, unlike the rep estimate). -1 when nothing's been seen. */
  reachedRank: number;
  /** Missions with no rank gate (the intro chain) — always offered. */
  intro: GrindMission[];
  /** Every guaranteed item on the track, with the rank that gates it. Ships live here. */
  rewards: { name: string; amount: number; rank: number | null; mission: string; received: boolean; unsure: boolean }[];
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
  /** 🔴 TRUE = this payout was MODELLED, not read out of the game files. The dataset carries
   *  a fitted curve (`payoutModel`) that fills the ~2,045 missions the datacore leaves at
   *  `reward="0"`, and the two are byte-identical in shape — `{min:39750,max:39750}` either
   *  way. Measured against real completions on 2026-08-14 it is wrong **one time in four**,
   *  by −79% to +61%, because what it reproduces is the datacore's `CalculatedReward`: a BASE
   *  the server modifies at accept time, not what lands in the wallet. So this flag is the
   *  only thing standing between an estimate and a claim of fact, and anything rendering
   *  `payout` MUST branch on it. See references/payout-scanner.md. */
  payoutCalculated?: boolean;
  /** ITEM rewards the mission hands out (schema/2) — actual items (Wikelo ships,
   *  armor, scrip), NOT blueprints. No ownership tracking; display-only. */
  items?: { name: string; item: string | null; amount: number }[] | null;
  /** Reputation gained (+) / lost (−) on completion, biggest first (schema/2).
   *  Empty/absent for the many missions the game data carries no rep for. */
  reputationGained?: RepEntry[];
  reputationLost?: RepEntry[];
  /** Every place this variant touches (offer sites + objective sites), resolved to
   *  starmap names. Null when the game data places it nowhere (~51% of missions).
   *  Load-bearing, not display: same-title variants can draw from DIFFERENT pools, and
   *  matching the log's objective text against these names is what picks the right one. */
  places?: string[] | null;
  /** Objective-site names only — the subset that says where the WORK is. */
  objective?: string[] | null;
  /** Short, station-first list of places the contract is OFFERED at — the display
   *  counterpart to `places`, which is deliberately unfiltered for matching and runs to
   *  30+ asteroid-cluster names on some variants. Absent on older datasets. */
  where?: string[] | null;
  /** Reputation RANK this mission requires (0,1,2…); null/absent = no rank gate (intro
   *  + story missions). The game only offers it once you've reached that rank, so
   *  accepting it proves you're at least there — that's how we infer standing. */
  rank?: number | null;
  /** Criminal work: the game hands you a CrimeStat for taking it. 100% populated in the
   *  dataset (704 of 4,075 contracts are illegal), and the one mission fact a player most
   *  wants BEFORE they accept rather than after. */
  illegal?: boolean | null;
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
/** How a blueprint came to be owned.
 *  🔑 `"fab"` is a MANUAL tick the player made at the fabricator, where the game itself
 *  was showing them the item — the kiosk only lists blueprints you own, so it is the one
 *  ownership signal that survives log rotation. Kept apart from `"manual"` on purpose:
 *  a site-side hand-tick is a claim, a fabricator confirmation is a claim BACKED BY a
 *  screen the player was looking at. Telling them apart is what makes the "this item is
 *  never in anyone's logs" analysis trustworthy. */
export type BlueprintSource = "in-game" | "manual" | "fab" | "default" | null;

export interface BlueprintStatus {
  name: string;
  owned: boolean;
  /** Why we think it's owned (in-game / manual / default), or null when not owned. */
  source: BlueprintSource;
  chance: number;
  /** Fabricator category tab (matches the in-game filter) + text sub-category. */
  tab: TabKey;
  sub: string;
  /** Output item UUID (from the pool entry) — the key to look up crafting detail via
   *  /api/blueprint-detail. Null when the pool entry carries no UUID. */
  item: string | null;
  /** True when a crafting recipe is on record for this blueprint (the detail dataset has
   *  it) — lets the overlay show an affordance without fetching the full recipe up front. */
  hasDetail: boolean;
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
/** Per-hour earning rates for the idle screen. rep is dataset-reliable; aUEC is null when the
 *  game logged no payout (calculated-reward missions) — the UI shows "—", never a false 0. */
export interface EarningRates {
  /** Rep gained in the last rolling 60 minutes of the current grind session. */
  repLastHr: number;
  /** Extrapolated rep/hr for the current grind session (null until ~1 min in). */
  repPace: number | null;
  /** aUEC in the last 60 min from missions with a KNOWN payout (null if none known). */
  aUECLastHr: number | null;
  /** Extrapolated aUEC/hr from known-payout missions this session (null if none known). */
  aUECPace: number | null;
  /** Total aUEC earned this session from KNOWN-payout missions (null if none known). A total,
   *  not a rate — the idle scoreboard shows what the session was worth. */
  aUECTotal: number | null;
  /** Total reputation earned this session. */
  repTotal: number;
  /** Completions counted in the current grind session (0 = nothing to rate yet). */
  missions: number;
}
/** A blueprint unlocked during a mission — the completion card shows its item image. */
export interface BlueprintReward {
  name: string;
  /** Resolved item UUID (the image key), or null if the name couldn't be resolved. */
  item: string | null;
  /** Preferred image: the crowdsourced FABRICATOR capture — the same picture the site's
   *  blueprint pages show, and the one players recognise from the in-game kiosk. Null when
   *  there's no UUID. 404s for any item nobody has captured yet, hence `imageFallback`. */
  image: string | null;
  /** The generated clay RENDER, used only when no capture exists. Distinct items can share a
   *  render (all three Scraper Modules reuse one game mesh, so their renders are byte-identical)
   *  — which is exactly why the capture has to be tried first. */
  imageFallback: string | null;
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
  /** True when `payout` is MODELLED rather than read from the game files — see the note on
   *  DatasetMission.payoutCalculated. The widget must render it as an estimate; it is wrong
   *  one time in four and is shaped exactly like a real payout. */
  payoutEstimated: boolean;
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
  /** Short station-first list of places this contract is OFFERED at, so the widget can
   *  answer "where do I go to get this?". Empty when the game data places it nowhere
   *  (~59% of missions) — and empty is the honest answer, not a guess.
   *  🔑 Only meaningful once the variant is resolved: same-title variants are offered in
   *  DIFFERENT regions with different pools, so an ambiguous mission's list would mix
   *  places that lead to different rewards. `view()` omits it while ambiguous. */
  whereToGet: string[];
  /** Criminal work — a CrimeStat comes with it. False when the dataset says so AND when we
   *  have no record of the mission at all, so treat it as "we are telling you it is illegal",
   *  never as "we are promising it is legal". */
  illegal: boolean;
  /** Same-title variants of THIS contract whose blueprint pool genuinely differs from the one
   *  being shown — i.e. the pools you can only reach by taking the contract somewhere else.
   *  Empty for the common case.
   *
   *  🔑 This is the single most useful thing the dataset knows and the app never said. Measured
   *  over 4,075 contracts: 540 titles have more than one variant, **80** have variants with
   *  DIFFERENT pools, and for **71** of those the place you accept it decides which pool you
   *  draw from. Sub, 2026-08-12: "I want people to know that they need to go to other places to
   *  wrap this pool up." Without it, a completed pool looks like the end of the title. */
  otherPools: { places: string[]; total: number; owned: number }[];
  /** The reputation rank the GIVER requires before offering this (0,1,2…), or null when the
   *  dataset carries no gate. 🔑 Distinct from `inferredRank`, which is YOUR standing. */
  rankRequired: number | null;
  /** That rank's NAME on the giver's own ladder ("Contractor"). Null when the ladder is shorter
   *  than the index, in which case the panel shows the number. */
  rankRequiredName: string | null;
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
  /** Pools you have started and are nearest to finishing — the idle panel leads with these,
   *  because "no mission tracked" is exactly when the useful question is what to go do next. */
  closestPools: ClosestPool[];
  /** Per-hour aUEC + rep rates for the idle screen. */
  earnings: EarningRates;
  /** The most-recently received blueprint (real-time receipts only), for the global
   *  "Blueprint Received" pop card — shown regardless of which mission is displayed, so a
   *  receipt is never missed when it lands on a same-named mission you aren't viewing.
   *  null until a blueprint is received live this session. `at` = the log receipt time. */
  justReceived: (BlueprintReward & { at: string }) | null;
  /** Present for ~30s after a mission COMPLETES — the report card's data (payout, duration,
   *  blueprints received, plus the crowdsourcing context). null the rest of the time.
   *  An abandoned mission never sets this: there is no reward to summarise and nothing worth
   *  asking about a contract you walked away from. */
  completion: {
    title: string | null;
    /** aUEC awarded (live "Awarded N aUEC"), or null if none correlated. */
    aUEC: number | null;
    /** The mission's static dataset payout (FixedReward) — shown on the card when no live
     *  award was logged (current patches stopped emitting "Awarded N aUEC"). null if none. */
    payout: { min: number | null; max: number; currency: string | null } | null;
    /** Accept→complete duration in ms, or null if the accept wasn't seen. */
    durationMs: number | null;
    /** Blueprints received during the mission (name + item image for the card). */
    blueprints: BlueprintReward[];
    /** Log time the mission ended. The report card's IDENTITY — it's what tells a re-render
     *  apart from a genuinely new completion, so the card doesn't restart its timer every
     *  time the view ticks. */
    at: string;
    /** The contract key this completion is for — the identity every piece of crowdsourced
     *  feedback is filed under. null when the mission never resolved to a dataset entry,
     *  which also means no feedback can be submitted for it. */
    contractKey: string | null;
    /** Who gave it, what CIG calls it, and the difficulty tier — context for the report. */
    giver: string | null;
    missionType: string | null;
    rank: number | null;
    /** Reputation the dataset says this mission grants. Carries `faction` as well as `scope` —
     *  `scope` is the internal ladder name ("FactionReputation"), so a card that shows it reads
     *  "FactionReputation +50" instead of "Headhunters +50". Display the faction. */
    reputationGained: RepEntry[];
    /** aUEC per hour for THIS run — the number people actually compare missions on.
     *  null unless both a payout and a duration are known. */
    aUecPerHour: number | null;
    /** How many times this contract has been completed, including this one. Counted off
     *  the contract key where possible; see recordMissionComplete for the title fallback. */
    timesCompleted: number | null;
    /** Blueprint-pool standing for this mission after the run — "you now have 7 of 15". */
    poolProgress: { owned: number; total: number } | null;
    /** What the game data already says the mission involves. `combat: null` is what makes
     *  the report ask the player instead of telling them. */
    classification: { combat: CombatProfile | null; activity: MissionActivity | null; source: "generator" | "missionType" | null };
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
  /** Blueprints the player confirmed AT THE FABRICATOR, where the game was showing them
   *  the item. Stored apart from `overrides` so a fabricator-backed claim stays
   *  distinguishable from a site-side hand-tick forever — see BlueprintSource. */
  fabOwned?: string[];
  /** Inferred reputation standing: mission giver -> highest rank we've seen them
   *  accept a mission at. Rep is server-side (never in the log), so this is the best
   *  available signal — a lower bound that only improves as they rank up. */
  inferredRank?: Record<string, number>;
  /** giver -> witnessed reputation total on their primary org scope (post-4.8 completions).
   *  A lower bound rebuilt by "Verify from logs"; older state files predate it. */
  repWitnessed?: Record<string, { scope: string; sum: number }>;
  /** missionIds already credited to repWitnessed. One completed mission raises THREE completion
   *  signals, so exactly-once accrual needs this to survive restarts — an in-memory guard let
   *  repeats through and every leak was permanent (see accrueForCompletion). Absent in older
   *  state files, which is harmless: the next "Verify from logs" rebuilds both together. */
  repAccruedMissionIds?: string[];
  /** normalized mission TITLE -> how many times it's been completed. The log never reports a
   *  mission's guaranteed physical rewards (ships, armour sets), but it DOES report the
   *  completion — so a completed count is the only honest "you actually received this" signal.
   *  Uncapped (unlike missionHistory, which is a rolling window) and rebuilt by Verify from logs. */
  completedTitles?: Record<string, number>;
  /** dataset mission KEY -> completion count. Titles COLLIDE (Battaglia's one-time intro missions
   *  share their title with repeatable ranked ones — "Blackbox Retrieval" is both the intro that
   *  grants the repeaters and a rank-2 job), so a title match can credit a reward you never got.
   *  The contract key is unambiguous; it's only known when a marker fired, so titles remain the
   *  fallback. */
  completedKeys?: Record<string, number>;
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

const ROMAN = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];

/** The runtime objective text and the starmap disagree on how to name a planet: the log
 *  says "Pyro 5a Abandoned Outpost", the starmap says "Pyro V" (moons carry proper names
 *  like "Adir", not letters). So a literal match on "Pyro 5a" finds nothing.
 *
 *  Rewrite "<Word> <digit><optional moon letter>" to the Roman-numeral planet form and
 *  keep the original too, so both notations can match. The trailing letter is dropped on
 *  purpose — the dataset lists the PARENT planet, and "Pyro V" is the discriminating
 *  token; nothing is lost because a moon's real name would already match literally. */
function placeAliases(text: string): string {
  const t = norm(text);
  return (
    t +
    " " +
    t.replace(/\b([a-z]+)\s*(\d{1,2})[a-z]?\b/g, (whole, word: string, num: string) => {
      const r = ROMAN[parseInt(num, 10)];
      return r ? `${whole} ${word} ${r}` : whole;
    })
  );
}

/** Pick the ONE mission variant whose place names the objective text names.
 *
 *  Scores each candidate by the LONGEST of its place names found in the text, because
 *  specificity is what discriminates: RegionC and RegionD both list "Pyro", and only the
 *  longer "Pyro V" / "Terminus" tells them apart. A tie, or no hit at all, returns null —
 *  the caller then keeps the merged view rather than guessing, since a confidently wrong
 *  variant is worse than an honestly ambiguous one.
 *
 *  🔑 "Pyro" alone is never enough. Short names are matched on a word boundary so
 *  "Adir" cannot hit inside another word. */
function narrowByPlace(
  text: string,
  candidates: { key: string; places: string[] }[],
): string | null {
  const hay = placeAliases(text);
  let best: { key: string; len: number } | null = null;
  let tied = false;
  for (const c of candidates) {
    let len = 0;
    for (const p of c.places) {
      const n = norm(p);
      if (n.length < 3) continue;
      const re = new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (re.test(hay) && n.length > len) len = n.length;
    }
    if (len === 0) continue;
    if (!best || len > best.len) { best = { key: c.key, len }; tied = false; }
    else if (len === best.len) tied = true;
  }
  return best && !tied ? best.key : null;
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
/** A file's first `bytes` bytes as text, for reading a log's header. "" when unreadable. */
function readHead(path: string, bytes = 4000): string {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return ""; }
  try {
    const buf = Buffer.allocUnsafe(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return n > 0 ? buf.toString("utf8", 0, n) : "";
  } catch { return ""; } finally { closeSync(fd); }
}

/** Stream a file's lines, holding only one chunk in memory.
 *
 *  🔴 THIS EXISTS BECAUSE `readFileSync(p, "utf8").split(/\r?\n/)` OOM-KILLED THE SIDECAR.
 *  "Verify from logs" scans every channel's game.log plus every logbackup — on Sub's machine 291
 *  PUB files, ~1.2 GB — and read-then-split holds the whole file as one string AND an array of
 *  every line in it at once, on top of a process that already has the datasets and OCR models
 *  resident. Measured 2026-08-03: it reached V8's **4 GB heap limit** in about 11 seconds and died
 *  with "Reached heap limit Allocation failed - JavaScript heap out of memory".
 *  🔑 The user-visible symptoms were TWO things that looked unrelated: the button reported "verify
 *  failed" (the fetch rejects when the process dies mid-request), and the overlay flashed
 *  "SC Overlay isn't tracking anything right now" for a second or two — the shell noticing the
 *  sidecar exit and respawning it. Same cause.
 *  A standalone script doing the same scan survives, which is a trap: the sidecar's baseline heap
 *  is what makes the difference, so this cannot be reproduced outside the real process.
 *  StringDecoder rather than buf.toString(): a 1 MiB read can land mid-UTF-8-sequence, and
 *  stitching the pieces as strings would corrupt that character. */
function* readLines(path: string): Generator<string> {
  const CHUNK = 1 << 20; // 1 MiB — big enough that syscall overhead is irrelevant, small enough to forget
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return; }
  const buf = Buffer.allocUnsafe(CHUNK);
  const dec = new StringDecoder("utf8");
  try {
    let rest = "";
    for (;;) {
      let n: number;
      try { n = readSync(fd, buf, 0, CHUNK, null); } catch { break; }
      if (n <= 0) break;
      let text = rest + dec.write(buf.subarray(0, n));
      let i = 0;
      for (;;) {
        const j = text.indexOf("\n", i);
        if (j < 0) break;
        const end = j > i && text.charCodeAt(j - 1) === 13 ? j - 1 : j; // strip \r, as split(/\r?\n/) did
        yield text.slice(i, end);
        i = j + 1;
      }
      rest = text.slice(i);
      text = ""; // drop the reference before the next read allocates another chunk
    }
    rest += dec.end();
    if (rest) yield rest.charCodeAt(rest.length - 1) === 13 ? rest.slice(0, -1) : rest;
  } finally { closeSync(fd); }
}

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
  let nextRank: number | null = null;
  for (let i = 0; i < asc.length; i++) {
    const r = asc[i];
    if (r.minRep <= estimate) cur = r;
    else { next = r; nextRank = i; break; }
  }
  return {
    standing: cur.name,
    estimate,
    curMin: cur.minRep,
    nextMin: next?.minRep ?? null,
    nextName: next?.name ?? null,
    nextRank,
    nextRewards: [],   // filled by the caller, which is what knows this giver's missions
    max: next == null,
    noData: witnessed <= 0,
  };
}

/** How long to keep a just-completed mission's summary card up before moving on. */
const COMPLETION_HOLD_MS = 30_000;
/** Abandoned missions get a shorter hold — just enough to explain the vanishing pool. */
/** An "Awarded N aUEC" counts as a mission's payout if it fired within this of the
 *  completion (the award's own missionId is null, so we correlate by log time). */
const REWARD_WINDOW_MS = 6_000;
/** Only show the completion card for a real-time completion — not the historical
 *  ones replayed when the app seeds from the log on startup. */
const COMPLETION_FRESH_MS = 90_000;
/** A gap between completions longer than this starts a fresh "grind session" for the idle
 *  per-hour rates, so a break doesn't drag the extrapolated pace down. */
const SESSION_GAP_MS = 20 * 60_000;
/** How many completed missions to retain for the idle recent-activity list. */
const MISSION_HISTORY_MAX = 200; // keep enough for a full-hour rate even on a fast grind (recentMissions still shows only the top few)

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
  /** Per-blueprint crafting detail (recipe/dismantle/stats/manufacturer), following the
   *  same changelist as `dataset`. Loaded from the bundled blueprint-detail.<cl>.json. */
  private detail: BlueprintDetailStore;
  private patch: string | null = null;
  private detectedChangelist: string | null = null;
  /** Version family (major.minor, e.g. "4.8") from the log header — picks the right
   *  dataset when the exact build isn't bundled. See detectPatch / loadDataset. */
  private detectedFamily: string | null = null;
  /** The environment tag of the log being watched: "PUB" = live, anything else is a test
   *  server (PTU/EPTU/TECH-PREVIEW). null = not seen yet.
   *  🔑 null must behave as LIVE. The app can attach to a log mid-session and never see the
   *  header, and refusing to track anything in that case would break the common install for
   *  the sake of the rare one. Only a POSITIVE non-PUB reading suppresses anything. */
  private logEnv: string | null = null;
  /** Whether receipts from the log currently being read should count toward the real
   *  collection. See logEnv. */
  private get isLiveEnv(): boolean {
    return this.logEnv === null || this.logEnv === "PUB";
  }

  /** Guaranteed ITEM rewards ticked by hand (manual-only — the log never reports item
   *  awards). Deliberately NOT part of `observed`/`overrides`, so these never count
   *  toward the blueprint total nor sync to the site. */
  private guaranteedOwned = new Set<string>();
  /** Blueprint names the player confirmed at the FABRICATOR. Unlike `guaranteedOwned`
   *  these ARE blueprints and DO count + sync — the point of the feature is recovering
   *  ownership the log never reported. Held separately only so the source stays "fab". */
  private fabOwned = new Set<string>();
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
  /** missionIds already credited to repWitnessed — see accrueForCompletion. Persisted, because
   *  the over-count it prevents is itself persisted. */
  private repAccruedMissionIds = new Set<string>();
  /** giver -> rank index -> the ITEMS that rank's missions hand over. Lazily built per giver
   *  (scanning every mission for each view build would be silly) and dropped on a new dataset. */
  private rankRewards = new Map<string, Map<number, string[]>>();
  /** normalized mission title -> completion count (see Persisted.completedTitles). */
  private completedTitles = new Map<string, number>();
  /** dataset mission key -> completion count (see Persisted.completedKeys). */
  private completedKeys = new Map<string, number>();
  /** normScreenTitle(mission title) -> the primary rep gain to credit when a mission with
   *  that title completes, or null when the title is ambiguous across givers/scopes. Built
   *  over ALL dataset missions (not just pooled ones), so combat/patrol/delivery missions
   *  with no blueprint reward still feed the rep bar. Same-org titles that differ only in
   *  amount (difficulty tiers) collapse to the MIN — a deliberate under-count. */
  private repTitleIndex = new Map<string, { giver: string; scope: string; amount: number } | null>();
  private observed = new Set<string>();
  /** blueprint name -> earliest in-game unlock time (ISO-8601 UTC from the log). */
  private observedAt = new Map<string, string>();
  /** The last blueprint received live this session (real-time only), for the global receipt
   *  pop card. Persists in the view (client dedupes by `at`); overwritten by the next receipt. */
  private justReceived: (BlueprintReward & { at: string }) | null = null;
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
  /** missionId → when it completed. The fence completionBlueprints() uses to keep one
   *  mission's receipts off the next mission's card when contracts overlap. */
  private completedAtByMission = new Map<string, number>();
  /** Any mission that logged an end (complete/fail/abandon) — dropped from the
   *  active picker and auto-follow so only missions you currently have show. */
  private endedMissionIds = new Set<string>();

  /** The brief "mission complete" summary card, shown over the just-completed
   *  mission for COMPLETION_HOLD_MS before the overlay moves to the next mission.
   *  Only set for real-time completions (see beginCompletion). */
  private completion:
    | { missionId: string; title: string | null; completedAtMs: number; acceptedAtMs: number | null; aUEC: number | null; payout: { min: number | null; max: number; currency: string | null } | null; until: number }
    | null = null;
  private completionTimer: ReturnType<typeof setTimeout> | null = null;
  /** DEV REPLAY ONLY — forced blueprint tiles for the current completion. See
   *  forceCompletionBlueprints(). Display-only; never persisted, never synced. */
  private forcedBlueprints: BlueprintReward[] | null = null;
  /** Last "Awarded N aUEC" seen (log time), to attach to the completion near it. */
  private lastReward: { amount: number; atMs: number } | null = null;
  /** Completed missions, newest first, capped — persisted for the idle recent list. */
  private missionHistory: MissionHistoryEntry[] = [];

  constructor(opts: MissionTrackerOptions) {
    super();
    this.dataDir = opts.dataDir;
    this.detail = new BlueprintDetailStore(opts.dataDir);
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
    // 🔑 Which ENVIRONMENT this log belongs to, read from the header the same way
    // verifyFromLogs does. The retroactive scan has always skipped non-PUB sessions; the
    // LIVE path never checked at all, so playing PTU with the app open folded test-server
    // blueprints into the real collection and SiteSync pushed them with replace:true — as
    // if earned on live. Sub, 2026-08-01: "no one's gonna want to track the PTU."
    // Detected here because every line already passes through this method.
    const env = /--envtag=.?([A-Za-z0-9_]+)|Environment:\s*([A-Za-z0-9_]+)/.exec(rawLine);
    if (env) this.logEnv = (env[1] || env[2] || "").toUpperCase() || null;

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
    // Only the remote-fetch path is async. When nothing needs fetching (offline, or the
    // files are already bundled/cached) there is NO await before loadDataset, so it stays
    // synchronous for the bundled case — callers that read view() right after a patch
    // detect (and the tests) depend on that.
    if (this.remoteBaseUrl) {
      await this.fetchIfMissing(`blueprints.${changelist}.json`);
      // Pull the matching crafting-detail dataset too, so a patch fetched online gets its
      // recipes/stats — not just its pools. Independent + best-effort: missing detail only
      // costs the recipe panel, never the pools.
      await this.fetchIfMissing(`blueprint-detail.${changelist}.json`);
    }
    this.loadDataset(changelist);
  }

  /** Download data/<file> from the remote endpoint into the writable data dir when it's
   *  not already present. Offline-safe + validated before caching; a failure is a no-op. */
  private async fetchIfMissing(file: string): Promise<void> {
    const local = join(this.dataDir, file);
    if (existsSync(local) || !this.remoteBaseUrl) return;
    try {
      const res = await fetch(`${this.remoteBaseUrl}/${file}`);
      if (res.ok) {
        const text = await res.text();
        JSON.parse(text); // validate before caching
        writeFileSync(local, text);
      }
    } catch {
      /* offline — fall through to bundled / latest */
    }
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
        // Follow the same changelist with the crafting-detail dataset (recipes/stats).
        this.detail.loadForChangelist(this.dataset.changelist);
        this.buildTitleIndex();
        this.buildRepTitleIndex();
        this.rankRewards.clear();   // keyed off dataset missions — a new dataset invalidates it
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
      // The objective text names WHERE the mission sends you, and that is the only log
      // signal that separates same-title variants drawing from DIFFERENT pools.
      //
      // Why this matters concretely: "Kill the king" has RegionA variants on a 10-blueprint
      // pool and RegionC/D variants on a different 8-blueprint pool. Resolving by title
      // alone, the app merged both into a fictional 18 and told Sub he had 4 left to win
      // while the variant he was actually running was 8/8 and could never drop anything.
      // He farmed a dead pool for a week. "Go to Pyro 5a Abandoned Outpost" → Pyro V →
      // RegionC, unambiguously.
      //
      // Only ever NARROWS an already-ambiguous title guess: a real marker (contractKey) is
      // authoritative and left alone, and a text that doesn't resolve to exactly one
      // candidate changes nothing.
      case "newObjective": {
        if (!ev.missionId || !this.dataset) break;
        const info = this.missions.get(ev.missionId);
        if (!info || !info.ambiguous || !info.acceptKeys || info.acceptKeys.length < 2) break;
        const candidates = info.acceptKeys
          .map((key) => ({ key, places: this.dataset!.missions[key]?.places ?? [] }))
          .filter((c) => c.places.length > 0);
        if (candidates.length < 2) break;
        const picked = narrowByPlace(ev.text, candidates);
        if (!picked) break;
        info.contractKey = picked;
        info.acceptKeys = [picked];
        info.ambiguous = false;
        this.missions.set(ev.missionId, info);
        this.noteRank(ev.missionId);
        this.emit("change");
        break;
      }
      // Routing to a region-scoped encounter set names the region OUTRIGHT
      // ("destination RegionB_1base_ab_pyro…"), and that token is literally what
      // separates HH_Pyro_RegionB_… from HH_Pyro_RegionC_…. Stronger than matching place
      // NAMES: no numeral translation, no shared-name ties. It is the signal that would
      // have resolved 2026-08-09's "Deep space hit", whose objective text was a bare
      // "Go to Asteroid Base" with no place in it at all.
      //
      // ⚠️ The line carries NO MissionId, so this is correlation, not attribution. Two
      // guards keep it honest:
      //   1. Only ACTIVE, still-ambiguous missions are considered.
      //   2. It must resolve to EXACTLY ONE mission and EXACTLY ONE of its variants. If
      //      two ambiguous missions could both take this region, nothing happens — a
      //      wrong pool is worse than an admittedly unknown one.
      case "routeRegion": {
        if (!this.dataset) break;
        // 🔑 Boundary-anchored, NOT a plain substring. The dataset has 16 keys containing
        // "Regional" and 20 containing "RegionLink", so a bare includes("regiona") would
        // match "Regional" and pick a completely unrelated variant. The token must not be
        // followed by another letter or digit.
        const token = new RegExp(`region${ev.region.replace(/[^a-z0-9]/gi, "")}(?![a-z0-9])`, "i");
        const hits: { missionId: string; key: string }[] = [];
        for (const [missionId, info] of this.missions) {
          if (!info.ambiguous || !info.acceptKeys || info.acceptKeys.length < 2) continue;
          if (this.endedMissionIds.has(missionId)) continue;
          const matching = info.acceptKeys.filter((k) => token.test(k));
          if (matching.length === 1) hits.push({ missionId, key: matching[0] });
        }
        if (hits.length !== 1) break;
        const { missionId, key } = hits[0];
        const info = this.missions.get(missionId)!;
        info.contractKey = key;
        info.acceptKeys = [key];
        info.ambiguous = false;
        this.missions.set(missionId, info);
        this.noteRank(missionId);
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
        // Any ended mission (complete/fail/abandon) leaves the active set, so the
        // picker matches what you actually have. COMPLETED also flags the badge.
        this.endedMissionIds.add(ev.missionId);
        // An ended mission can't stay pinned — the pin would keep its pool on screen.
        if (ev.missionId === this.selectedMissionId) this.selectedMissionId = null;
        if (ev.state.includes("COMPLETED")) {
          this.completedMissionIds.add(ev.missionId);
          // 🔑 NOT gated on `wasDisplayed`. Sub's requirement (2026-07-30): the report must fire
          // for whichever mission actually ENDED, not whichever one the panel happens to be
          // showing — he routinely runs several contracts at once and the auto-followed one is
          // often the wrong one. The old display gate meant finishing an untracked mission
          // produced no report and no chance to answer the questions.
          this.beginCompletion(ev.missionId, this.missions.get(ev.missionId)?.title ?? null, ev.ts);
          // 🔑 A separate event from "change", which fires on every log line. This one means
          // exactly "a contract was finished", which is the only thing a completion counter
          // may count — and it carries the contractKey the log's own notification line does
          // NOT have, so a live completion can be attributed to a specific same-titled
          // variant where a log backfill never can.
          this.emit("completed", {
            contractKey: this.missions.get(ev.missionId)?.contractKey ?? "",
            title: this.missions.get(ev.missionId)?.title ?? "",
            at: ev.ts,
          });
        }
        // 🔑 An ABANDON shows NOTHING (Sub, 2026-07-30, after one popped at him). The report is a
        // reward summary that asks you to rate a mission you just played — none of which applies
        // to a contract you walked away from, and taking the whole panel over to tell you about
        // something you chose to do is pure interruption. The old brief "abandoned" card existed
        // to explain the pool vanishing; the panel simply moves to the next mission now.
        this.emit("change");
        break;
      }

      case "contractComplete": {
        // Friendlier completion signal (has the title); usually fires just before the
        // MissionEnded push. Fires the report for ANY mission that completes — see the `end`
        // case above for why the old "only the mission on screen" gate was wrong. Whichever of
        // the two signals arrives first wins; beginCompletion is idempotent per missionId.
        if (ev.missionId) {
          const info = this.missions.get(ev.missionId) ?? {};
          if (ev.title && !info.title) info.title = ev.title;
          this.missions.set(ev.missionId, info);
          this.beginCompletion(ev.missionId, ev.title, ev.ts);
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
        // A test-server receipt is not part of your live collection and must never sync.
        // Dropped here rather than filtered later: `observed` is the authoritative set
        // SiteSync pushes with replace:true, so anything that reaches it is already live.
        if (!this.isLiveEnv) break;
        const isNew = !this.observed.has(ev.name);
        const dateChanged = this.noteReceiptTime(ev.name, ev.ts);
        if (isNew) this.observed.add(ev.name);
        // Global "Blueprint Received" pop card — REAL-TIME receipts only (not the historical
        // replay on startup), and independent of the displayed mission. Set before emitting so
        // the broadcast view carries the resolved image. Gated by COMPLETION_FRESH_MS like the
        // completion card so seeding the log at launch never pops a stale card.
        if (isNew) {
          const t = ev.ts ? Date.parse(ev.ts) : Date.now();
          if (!Number.isFinite(t) || Date.now() - t < COMPLETION_FRESH_MS) {
            this.justReceived = { ...this.blueprintReward(ev.name), at: ev.ts ?? new Date().toISOString() };
          }
        }
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
  ): void {
    const completedAtMs = ts ? Date.parse(ts) : Date.now();
    if (!Number.isFinite(completedAtMs)) return;
    // 🔑 Recorded BEFORE the freshness gate below and for every completion, carded or not:
    // completionBlueprints() uses these to stop one mission's receipts landing on the next
    // card, and a completion whose card was suppressed still produced a receipt that has to
    // be fenced off. Keyed by missionId so the two completion signals (contractComplete and
    // MissionEnded) can't record the same mission twice with slightly different times.
    if (!this.completedAtByMission.has(missionId)) this.completedAtByMission.set(missionId, completedAtMs);
    const info = this.missions.get(missionId);
    const aUEC =
      this.lastReward && Math.abs(this.lastReward.atMs - completedAtMs) <= REWARD_WINDOW_MS
        ? this.lastReward.amount
        : null;
    // Record to the persisted recent-mission history for BOTH real-time and
    // startup-replayed completions (the summary card below stays gated to real-time).
    // Store the best-known payout: the live award, else the mission's FIXED dataset payout
    // (min===max) resolved NOW while the mission is still accepted — so the idle aUEC/hr can
    // count fixed-payout missions. Calculated-reward missions stay null (→ "—").
    {
      const p = this.datasetMission(missionId)?.payout ?? null;
      const fixed = p && p.min != null && p.min === p.max && p.max > 0 ? p.max : null;
      this.recordMissionComplete(missionId, title ?? info?.title ?? null, ts, aUEC ?? fixed);
    }
    // 🔑 Logged from the SIDECAR, so it lands in sidecar.log and can actually be read — the shell
    // is a detached GUI process whose stdout goes nowhere. This exists because a real completion
    // (2026-07-31T01:33:50Z) was recorded into the history but produced NO card, and the history
    // write above happens BEFORE this gate — which is the only path that yields exactly that.
    // `lag` is how far behind the game the watcher was when it read the line; if a missing card
    // ever correlates with a lag near the limit, this gate is the cause and the limit is the fix.
    const lagMs = Date.now() - completedAtMs;
    if (lagMs > COMPLETION_FRESH_MS) {
      console.log(`[completion] NO CARD for "${title ?? info?.title ?? "?"}" — log line was ${(lagMs / 1000).toFixed(1)}s old (limit ${COMPLETION_FRESH_MS / 1000}s)`);
      return; // historical replay — no card
    }
    console.log(`[completion] card for "${title ?? info?.title ?? "?"}" — read ${lagMs}ms after the game logged it`);
    if (this.completion && this.completion.missionId === missionId) {
      if (title && !this.completion.title) this.completion.title = title;
      return;
    }
    // Real-time completion: fold its rep gain into the giver's witnessed total for the rep bar.
    // The current session is always the current patch (post-4.8-wipe), so no window check.
    //
    // 🔴 GATED ON A PERSISTED PER-MISSION SET, NOT on the guard above. Measured on Sub's real
    // 4.9 logs (2026-08-03): every single completion reaches beginCompletion **three** times —
    // the game logs TWO COMPLETED end events (MissionEnded and EndMission, both parsing to
    // `kind: "end"`) plus one contractComplete. 244 end events and 122 contractComplete for 122
    // missions, and NOT ONE mission got fewer than 3.
    // The guard above is `this.completion`, a SINGLE slot that expires after COMPLETION_HOLD_MS,
    // so it only absorbs repeats that arrive back-to-back with nothing in between — and Sub
    // "routinely runs several contracts at once" (see the `end` case), which is exactly the
    // interleaving that lets a repeat through. `repWitnessed` is PERSISTED while that slot is
    // in-memory, so every leak is permanent and they compound for the life of the profile: his
    // Battaglia standing read 144,200 (Prestige 3) where a from-scratch verify computes 24,700
    // (Prestige 1) off the same logs.
    // Rep is the one thing here that must be exactly-once, so it gets its own idempotency —
    // the same shape as completedMissionIds, which already existed for precisely this reason.
    //
    // 🔑 The key is passed ONLY when the mission is unambiguous. An ambiguous accept sets
    // contractKey to `res.keys[0]` as a REPRESENTATIVE for pool/content lookups (see the accept
    // handler) — good enough to draw a merged pool, but for rep it would silently pick one
    // variant's award out of several that differ. The title index is the right answer there:
    // it collapses same-title variants to the MIN, which under-claims instead of guessing.
    this.accrueForCompletion(
      missionId,
      title ?? info?.title ?? null,
      info?.ambiguous ? null : info?.contractKey ?? null,
    );
    this.forcedBlueprints = null; // a new completion never inherits the last one's dev override
    this.completion = {
      missionId,
      title: title ?? info?.title ?? null,
      completedAtMs,
      acceptedAtMs: info?.acceptedAt ?? null,
      aUEC,
      payout: this.datasetMission(missionId)?.payout ?? null,
      until: Date.now() + COMPLETION_HOLD_MS,
    };
    if (this.completionTimer) clearTimeout(this.completionTimer);
    this.completionTimer = setTimeout(() => {
      this.completion = null;
      this.forcedBlueprints = null;
      this.completionTimer = null;
      this.emit("change"); // hold expired → overlay moves to the next mission
    }, COMPLETION_HOLD_MS);
    this.saveState(); // persist the new recent-mission entry
    this.emit("change");
  }

  /** aUEC/hour for the just-completed run. Uses the live award if one was logged, else the
   *  mission's FIXED dataset payout — a calculated-reward mission has no honest number here
   *  and returns null rather than a made-up one. Sub-minute runs are excluded: dividing a
   *  payout by 20 seconds produces a rate nobody can actually sustain. */
  private completionRate(): number | null {
    const c = this.completion;
    if (!c || c.acceptedAtMs == null) return null;
    const ms = c.completedAtMs - c.acceptedAtMs;
    if (!(ms >= 60_000)) return null;
    const p = c.payout;
    const amount = c.aUEC ?? (p && p.min != null && p.min === p.max && p.max > 0 ? p.max : null);
    if (amount == null) return null;
    return Math.round(amount / (ms / 3_600_000));
  }

  /** Blueprint names received during the completed mission — the tiles on the completion card.
   *
   *  🔴 THE WINDOW MAY NOT REACH BACK PAST THE PREVIOUS COMPLETION. It used to open at this
   *  mission's ACCEPT time, which is wrong the moment two contracts overlap — and running
   *  several at once is the normal way to play. Finish A at 10:10 and B (accepted 10:05) at
   *  10:12 and B's window was [10:05, 10:12], so A's blueprint was inside it: Sub unlocked ONE
   *  blueprint and the card showed two, the second being an M8A from an earlier mission
   *  (2026-08-09, "when I do missions in rapid succession it might just merge the images").
   *
   *  🔑 The floor is the previous completion's window END, not the completion itself. A receipt
   *  lands 0–1s AFTER the completion it belongs to, so a floor at the bare completion time
   *  leaves it sitting inside the next mission's window — which is the bug, not the fix.
   *
   *  Two completions closer together than REWARD_WINDOW_MS therefore leave the second card
   *  empty. That is the honest answer: with the receipts interleaved there is no evidence in
   *  the log saying which mission paid out, and the log never attributes a blueprint to a
   *  mission (every receipt carries an all-zeros MissionId). A confidently wrong tile is worse
   *  than a missing one — the same rule the split-pool fix rests on.
   *
   *  🔑 A missing accept no longer means -Infinity. It used to, so an app that attached
   *  mid-session (no accept seen) matched EVERY receipt it had ever replayed. */
  private completionBlueprints(): BlueprintReward[] {
    const c = this.completion;
    if (!c) return [];
    let priorEnd = -Infinity;
    for (const [id, t] of this.completedAtByMission) {
      if (id !== c.missionId && t < c.completedAtMs) priorEnd = Math.max(priorEnd, t + REWARD_WINDOW_MS);
    }
    const lo = Math.max(c.acceptedAtMs ?? c.completedAtMs - REWARD_WINDOW_MS, priorEnd);
    const hi = c.completedAtMs + REWARD_WINDOW_MS;
    const out: BlueprintReward[] = [];
    for (const [name, ts] of this.observedAt) {
      const t = Date.parse(ts);
      if (Number.isFinite(t) && t >= lo && t <= hi) out.push(this.blueprintReward(name));
    }
    return out;
  }

  /** Resolve a received blueprint name to its item UUID + the images to display it with.
   *
   *  🔑 TWO sources, and the order matters. `/api/fab-img/<uuid>` is the crowdsourced capture of
   *  the real in-game fabricator entry — what the site's blueprint pages show, and what a player
   *  recognises. `/sc/items/<uuid>.webp` is a generated clay render, which exists for nearly
   *  everything but is a grey untextured mesh AND is shared between items that reuse a model:
   *  Abrade / Cinch / Trawler Scraper Module all return the byte-identical render, so the render
   *  alone can't even tell you which of the three you unlocked. The capture 404s for anything
   *  nobody has captured yet, so the client tries `image` first and falls back to `imageFallback`. */
  private blueprintReward(name: string): BlueprintReward {
    const item = this.itemUuidsForName(name)[0] ?? null;
    const base = this.remoteBaseUrl ?? "https://subliminal.gg/sc";
    // `base` points at the /sc asset root; the capture endpoint is a sibling API route.
    const site = base.replace(/\/sc\/?$/, "");
    return {
      name,
      item,
      image: item ? `${site}/api/fab-img/${item}` : null,
      imageFallback: item ? `${base}/items/${item}.webp` : null,
    };
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
    if (title) {
      const k = normScreenTitle(title);
      this.completedTitles.set(k, (this.completedTitles.get(k) ?? 0) + 1);
    }
    // Prefer the unambiguous contract key when this completion has one.
    const ck = missionId ? this.missions.get(missionId)?.contractKey : undefined;
    if (ck) {
      const key = contractKeyOf(ck);
      this.completedKeys.set(key, (this.completedKeys.get(key) ?? 0) + 1);
    }
    this.missionHistory.push({ missionId: missionId ?? null, title: title ?? null, aUEC, at });
    this.missionHistory.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    if (this.missionHistory.length > MISSION_HISTORY_MAX) this.missionHistory.length = MISSION_HISTORY_MAX;
  }

  private recentMissions(n = 10): RecentMission[] {
    return this.missionHistory.slice(0, n).map((m) => ({ title: m.title, aUEC: m.aUEC, at: m.at }));
  }

  /** The pools you are NEAREST to finishing — the idle panel's "what should I go do" answer.
   *
   *  🔑 Started, not finished, and ranked by what is LEFT rather than by percentage. A pool with
   *  one blueprint missing is a better suggestion than one at 90% of forty, because the whole
   *  point is the trip you can actually close out. Ties break on the higher percentage, so two
   *  pools needing one each put the nearly-done one first.
   *
   *  Untouched pools are excluded on purpose: with 4,075 contracts, "0 of 7" is not a suggestion,
   *  it is the entire dataset sorted arbitrarily. Something you have already put work into is
   *  evidence you meant to. */
  /** Every system name the dataset knows, from its own place lists ("Pyro System" → "pyro").
   *  Built from the data rather than hardcoded, so a new system arriving in a patch needs no
   *  code change to be recognised. */
  private systemNames(): Set<string> {
    if (this.systemNamesCache) return this.systemNamesCache;
    const found = new Set<string>();
    for (const m of Object.values(this.dataset?.missions ?? {})) {
      for (const p of m.places ?? []) {
        const hit = /^(.+?)\s+System$/i.exec(p);
        if (hit) found.add(hit[1].trim().toLowerCase());
      }
    }
    this.systemNamesCache = found;
    return found;
  }
  private systemNamesCache: Set<string> | null = null;

  /** Every ordinary place name → the system it sits in, learned from the missions that DO name
   *  their system.
   *
   *  🔑 Needed because most missions don't. Only some place lists carry "Pyro System" outright;
   *  the rest just say "Checkmate", "Gaslight", "ArcCorp" — so a filter that only understood the
   *  explicit form let almost everything through, which is how a Stanton contract stayed on
   *  screen while Sub was in Pyro. Every mission that names a system teaches us its other places,
   *  and the majority wins per place: a handful of cross-system contracts can't outvote the
   *  hundreds that agree Gaslight is in Pyro. */
  private placeSystemIndex(): Map<string, string> {
    if (this.placeSystemCache) return this.placeSystemCache;
    const votes = new Map<string, Map<string, number>>();
    for (const m of Object.values(this.dataset?.missions ?? {})) {
      const sys = this.explicitSystem(m.places);
      if (!sys) continue;
      for (const p of m.places ?? []) {
        const k = p.trim().toLowerCase();
        if (!k || this.systemNames().has(k) || /\s+system$/i.test(k)) continue;
        let bag = votes.get(k);
        if (!bag) { bag = new Map(); votes.set(k, bag); }
        bag.set(sys, (bag.get(sys) ?? 0) + 1);
      }
    }
    const index = new Map<string, string>();
    for (const [place, bag] of votes) {
      let best = "", bestN = 0;
      for (const [sys, count] of bag) if (count > bestN) { best = sys; bestN = count; }
      if (best) index.set(place, best);
    }
    this.placeSystemCache = index;
    return index;
  }
  private placeSystemCache: Map<string, string> | null = null;

  /** A system named outright in a place list ("Pyro System", or a bare "Pyro"). */
  private explicitSystem(places: string[] | null | undefined): string | null {
    for (const p of places ?? []) {
      const hit = /^(.+?)\s+System$/i.exec(p);
      if (hit) return hit[1].trim().toLowerCase();
    }
    // The bare name appears too, checked against the vocabulary above so an ordinary place that
    // happens to share a word can't be mistaken for a system.
    for (const p of places ?? []) {
      const k = p.trim().toLowerCase();
      if (this.systemNames().has(k)) return k;
    }
    return null;
  }

  /** Which system a mission is offered in: named outright if it says so, otherwise the system
   *  most of its places belong to. Null only when nothing in the list is recognised. */
  private systemOf(places: string[] | null | undefined): string | null {
    const explicit = this.explicitSystem(places);
    if (explicit) return explicit;
    const index = this.placeSystemIndex();
    const tally = new Map<string, number>();
    for (const p of places ?? []) {
      const sys = index.get(p.trim().toLowerCase());
      if (sys) tally.set(sys, (tally.get(sys) ?? 0) + 1);
    }
    let best: string | null = null, bestN = 0;
    for (const [sys, count] of tally) if (count > bestN) { best = sys; bestN = count; }
    return best;
  }

  /** Where the player is ACTUALLY playing, from the system of their most recent completion.
   *
   *  🔑 Chosen over the log's terrain report on purpose. That report is explicitly "a hint, not a
   *  gate" — it fires about every ten minutes and goes stale in twenty-one, so after any restart
   *  it reads unknown until the next dump. A completion is evidence you were standing there, it
   *  is backfilled from the logs so it survives a restart, and you cannot leave a system without
   *  a quantum jump — the same reasoning the payout scanner uses to never expire its cache.
   *
   *  Returns null when nothing recent carries a system, and callers must treat that as "show
   *  everything" rather than "show nothing" — a filter that silently empties a panel is worse
   *  than one that doesn't fire. */
  /** What the giver's required rank is CALLED — "Contractor", not "2".
   *
   *  🔑 The names are already bundled: rep-scopes.json carries all 35 ladders with their rungs,
   *  and a mission's rank is an index into the ladder of its own primary rep scope. Measured over
   *  the dataset: 2,549 of 2,738 ranked missions resolve to a name (93%). The rest sit above a
   *  short ladder — Headhunters' own Mercenary track has three rungs — and keep the number,
   *  because inventing a name for a rung that isn't there would be worse than a bare integer. */
  private rankName(m: DatasetMission | undefined): string | null {
    if (!m || typeof m.rank !== "number") return null;
    const scope = this.primaryRep(m)?.scope;
    const rung = scope ? this.repScopes[scope]?.ranks?.[m.rank] : null;
    return rung?.name ?? null;
  }

  /** The system every place list agrees exists — handed to the log watcher as its vocabulary. */
  knownSystems(): Set<string> { return new Set(this.systemNames()); }
  /** The system the LOG says the player is in, pushed in from the quantum-navigation watcher. */
  setSystem(sys: string | null): void { this.loggedSystem = sys; }
  private loggedSystem: string | null = null;

  private playingIn(): string | null {
    // 🔑 THE LOG FIRST. It states the system outright on every quantum-navigation line, which is
    // a fact rather than an inference — and it updates the moment the player jumps, where the
    // fallback below cannot know until they finish something on the other side.
    if (this.loggedSystem) return this.loggedSystem;
    // Fallback (Sub's, and the right one): the system of the most recent completion. Evidence
    // they were standing there, backfilled from the logs so it survives a restart, and available
    // immediately at launch — before any quantum drive has been touched this session.
    for (const h of this.missionHistory) {
      if (!h.title) continue;
      // Same-titled variants can sit in different systems, so every key under this title is
      // consulted and the first that names one wins — they agree far more often than not, and
      // a disagreement is exactly the ambiguity the tracker already refuses to resolve blind.
      for (const key of this.titleIndex.get(normScreenTitle(h.title)) ?? []) {
        const sys = this.systemOf(this.dataset?.missions?.[key]?.places);
        if (sys) return sys;
      }
    }
    return null;
  }

  private closestPools(n = 2): ClosestPool[] {
    const out: ClosestPool[] = [];
    if (!this.dataset) return out;   // no dataset loaded yet — the idle panel just shows less
    // 🔴 Only what you can actually reach. Sub, 2026-08-13, in Pyro and being shown Nyx pools:
    // "I don't want to see anything for Nyx." A suggestion in another system is not a suggestion,
    // it is a chore you cannot start — and the panel exists to answer "what should I go do now".
    const here = this.playingIn();
    for (const [key, m] of Object.entries(this.dataset.missions)) {
      if (here) {
        const sys = this.systemOf(m.places);
        // Unknown stays IN. 2,092 of 4,075 missions carry no place list at all, and dropping
        // every one of them would quietly hide most of the dataset to enforce a guess.
        if (sys && sys !== here) continue;
      }
      const entries = Object.values(m.pools ?? {}).flat();
      if (entries.length < 2) continue;   // a one-item pool is not a collection to finish
      let owned = 0;
      for (const e of entries) if (this.isOwned(e.blueprint).owned) owned++;
      if (owned === 0 || owned === entries.length) continue;   // untouched, or already done
      out.push({
        key,
        title: m.title,
        owned,
        total: entries.length,
        // Where to take it. `where` is the availability list the mission-info drawer uses; a
        // suggestion you cannot act on is just a statistic.
        places: (m.where ?? []).slice(0, 2),
      });
    }
    out.sort((a, b) => (a.total - a.owned) - (b.total - b.owned)
      || b.owned / b.total - a.owned / a.total
      || a.title.localeCompare(b.title));
    // 🔴 SAME-TITLED VARIANTS ARE SEPARATE DATASET KEYS, and 460 of the 540 multi-variant titles
    // are the SAME pool offered in several places — so the raw list opens with the same contract
    // twice, identical counts and all, which reads as a bug rather than a suggestion. Seen live
    // on Sub's collection the moment this shipped: "CRITICAL FLEET REFUEL 5/8" listed twice.
    // Collapsed on title + how far through it is, merging the places, because to someone deciding
    // where to go those really are one errand.
    const seen = new Map<string, ClosestPool>();
    for (const p of out) {
      const k = p.title + "|" + p.owned + "/" + p.total;
      const had = seen.get(k);
      if (!had) { seen.set(k, { ...p, places: [...p.places] }); continue; }
      for (const place of p.places) if (!had.places.includes(place)) had.places.push(place);
    }
    return [...seen.values()].slice(0, n).map((p) => ({ ...p, places: p.places.slice(0, 3) }));
  }

  private recentBlueprints(n = 10): RecentBlueprint[] {
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
    /** missionId -> contract key, harvested from every CreateMarker in the scan so the rep
     *  rebuild can resolve each completion to its exact dataset variant. */
    const missionKeys = new Map<string, string>();
    let files = 0;
    let receipts = 0;
    let skipped = 0;
    for (const p of paths) {
      // 🔑 HEADER FIRST, as its own 4 KB read, then STREAM the body — never the whole file.
      // Reading each log with readFileSync().split() OOM-killed the sidecar at V8's 4 GB heap
      // limit on Sub's 291-file / 1.2 GB set (see readLines). Reading the header separately also
      // means a wrong-environment log costs one page instead of its whole size.
      const head = readHead(p);
      if (!head) continue; // unreadable
      // Environment tag lives in the header (--envtag='PUB' / Environment: PUB).
      // Anything not PUB is a test environment — skip it.
      const env = /--envtag=.?([A-Za-z0-9_]+)|Environment:\s*([A-Za-z0-9_]+)/.exec(head);
      const tag = (env?.[1] || env?.[2] || "").toUpperCase();
      if (tag && tag !== "PUB") {
        skipped++;
        continue;
      }
      // Version family (major.minor) from the header — the 4.8 wipe means only 4.8+
      // completions count toward the rep bar (blueprints are unaffected, so they still
      // count from every PUB log regardless of family).
      const famM = /(?:Product|File)Version:\s*(\d+\.\d+)/.exec(head);
      const inWindow = familyAtLeast48(famM?.[1] ?? null);
      files++;
      for (const line of readLines(p)) {
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
          // 🔑 The marker is the ONLY line that names which dataset variant a mission actually
          // is, and it carries the same missionId the completion does — so remembering it here
          // is what lets the rep rebuild below credit the exact award instead of guessing from
          // the title. Measured on Sub's 312 PUB logs: 449 of 456 completions have one. Held for
          // the whole scan (not per file) because a mission can be accepted in one session's log
          // and completed in the next; a UUID collision across sessions is not a real risk.
          missionKeys.set(ev.missionId, ev.contractKey);
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
    // count (the wipe reset earlier rep). Each completion resolves through its own
    // CreateMarker contract key — the exact variant, so the award is the one that variant
    // pays — falling back to the rep-title index for the few that have no marker.
    // 🔑 Deduped by missionId as well as cleared. The log holds THREE completion signals per
    // mission (two COMPLETED end events plus a contractComplete — measured, see
    // beginCompletion), and only `contractComplete` carries a title, so a title-keyed loop
    // happens to see one per mission today. That is luck, not a rule: the moment anything else
    // starts contributing titled completions this loop would multiply them. Recovering a profile
    // that has been over-counted is the whole point of this rebuild, so it must not be able to
    // reintroduce the same fault.
    this.repWitnessed.clear();
    this.repAccruedMissionIds.clear();
    for (const c of completions) {
      if (c.inWindow) {
        this.accrueForCompletion(c.missionId, c.title, c.missionId ? missionKeys.get(c.missionId) : null);
      }
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

  /** Tick a blueprint the player CONFIRMED at the fabricator. Separate from `setOwned`
   *  only so the source survives as "fab" — see BlueprintSource for why that matters.
   *  🔑 Never overrides an explicit not-owned tick: if the player has deliberately said
   *  they don't have this, a kiosk glance must not silently contradict them. */
  setFabOwned(blueprintName: string): boolean {
    if (this.overrides.get(blueprintName) === false) return false;
    if (this.fabOwned.has(blueprintName)) return false;
    this.fabOwned.add(blueprintName);
    this.saveState();
    this.emit("change");
    return true;
  }

  /** Is this blueprint already accounted for — by a receipt, a fabricator confirmation,
   *  a manual tick, or the starter set? Drives the "should we even prompt" decision. */
  isAlreadyOwned(blueprintName: string): boolean {
    return this.isOwned(blueprintName).owned;
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
    // 🔑 The mission RECORDS go too, not just the sequences that index them. Mission ids are
    // per-connection instance GUIDs, so none of these survive a shard change — but leaving the
    // map populated while clearing endedMissionIds below un-ends every mission the tracker has
    // ever seen, and a stale record is not reachable through the seqs yet IS reachable through
    // setScreenMission(), which scans the whole map. Sub, 2026-08-08: a "Deep space hit"
    // completed at 22:00 came back hours and three session resets later, because OCR matched
    // its leftover record on title and pushed it into acceptedSeq as a live mission.
    this.missions.clear();
    // Per-shard too, and the one pointer nothing else clears — it outranks trackedMissionId in
    // effectiveMissionId(), so a stale value re-shows the previous shard's mission on spawn-in.
    this.screenMissionId = null;
    this.endedMissionIds.clear();
    this.completedMissionIds.clear();
    // Mission ids are per-connection GUIDs, so none of these times can describe anything on
    // the other side of a shard change.
    this.completedAtByMission.clear();
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
      // 🔑 Never RESURRECT a mission that already ended in this shard. The in-game title
      // lingers on screen after a contract completes, so the next OCR read finds no active
      // candidate and used to fall straight through to the synthetic registration below —
      // re-registering the mission you just finished under a GUESSED contract key. That
      // phantom then outranks the real one in effectiveMissionId() (screenMissionId beats
      // trackedMissionId), can never be flagged completed or ended (completion events carry
      // the runtime GUID, not this id), and shows the MERGED pool of every dataset variant
      // sharing the title. Sub, 2026-08-07: "Kill the king" (really RegionC Derelict, one
      // pool, 8/8 owned) came back as Rustville, 14/18, stuck on screen as incomplete.
      // Matched one candidate at a time on purpose — matchScreenTitle is tie-safe and would
      // return null if the same title ended TWICE, which is exactly when we most want to
      // refuse. The genuine recovery case is untouched: Alt-F4 → relaunch runs through
      // resetSession(), which clears endedMissionIds, so there is nothing here to match.
      const endedSameTitle = [...this.missions].some(
        ([id, info]) => info.title && this.endedMissionIds.has(id) && matchScreenTitle(title, [{ id, title: info.title }]),
      );
      if (endedSameTitle) return false;
      const res = this.resolveAcceptTitle(title);
      const key = res?.keys[0];
      if (key) {
        // 🔑 Match against EVERY key this title can resolve to, not just keys[0]. A `marker`
        // event sets contractKey but NOT title, so a mission is title-less — and therefore
        // invisible to the matcher above — until its accept line is parsed. Those two lines are
        // ~6ms apart in the log but land in separate watcher reads often enough to matter, and
        // an OCR poll in that gap used to mint a phantom beside the real, marker-identified
        // mission. Comparing only keys[0] guaranteed a miss whenever the player was on any
        // variant BUT the first: Sub, 2026-08-07, was on RegionC "Deep space hit" (8/8) and
        // keys[0] is RegionA, so the panel showed the correct 8/8 and then flipped to a
        // merged 14/18 the moment OCR ran. A marker's key is authoritative; a title guess is
        // not, so an existing mission always wins over minting a new one.
        const keys = new Set(res!.keys);
        const live = [...this.missions].filter(([id, info]) => info.contractKey && keys.has(info.contractKey) && !this.endedMissionIds.has(id));
        // Prefer a real log-registered mission over a synthetic one left by an earlier read.
        const existing = live.find(([id]) => !id.startsWith("ocr:")) ?? live[0];
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
   *  null when the mission grants no rankable rep (intro/story/pure-item missions).
   *
   *  🔑 Taking only the LARGEST when a mission lists several against the same standing is
   *  MEASURED, not a guess (2026-07-29). Sub's in-game Battaglia bar sat at 60.1% of the
   *  Prestige 1→2 band (10,800→30,000), implying ~22,334 rep. Counting the largest gives
   *  21,900 — 434 under, inside the ±326 slop of reading a bar off a screenshot and explained
   *  by this estimate being a documented lower bound. Adding the second entries as well would
   *  give 23,540: 1,206 OVER what the game shows, four times outside that slop. So whatever
   *  the second entry is for, it does not land in your standing. Don't "fix" this by summing. */
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
  /** Returns whether anything was actually credited — which is what decides if the completion
   *  counts as spent (see accrueForCompletion). */
  private accrueFromTitle(title: string | null | undefined): boolean {
    if (!title) return false;
    const e = this.repTitleIndex.get(normScreenTitle(title));
    if (!e) return false;
    const cur = this.repWitnessed.get(e.giver);
    if (cur && cur.scope === e.scope) cur.sum += e.amount;
    else this.repWitnessed.set(e.giver, { scope: e.scope, sum: (cur?.sum ?? 0) + e.amount });
    return true;
  }

  /** Credit a completed mission's rep from its CONTRACT KEY — the exact dataset variant, so the
   *  award is the one that variant actually pays. Returns whether anything was credited.
   *
   *  🔑 This is the accurate path and the title index is only the fallback, because a title
   *  cannot identify a mission. Two ways it fails, both measured on Sub's real logs 2026-08-13
   *  while his Headhunters bar read 4,225 against a true 7,475 (Contractor, when the game had
   *  just given him Sr. Contractor at 5,800):
   *    1. **547 of 4,075 dataset missions carry a PLACEHOLDER title** — "Need a death at
   *       [Location]", "Wanted: [TargetName]". The game substitutes at runtime ("Need a death at
   *       Asteroid Base"), so the lookup can never match and those completions credited ZERO,
   *       forever. 23 of his Headhunters completions, +3,150 rep, and it hits the biggest earner
   *       he runs (that one pays 300).
   *    2. **Same-title variants collapse to the MIN award** (buildRepTitleIndex, deliberately
   *       conservative). "Reputation Management" credited 25 where the rank-3 variant pays 300.
   *  A contract key has neither problem. `CreateMarker` carries one against the completing
   *  mission's own id on 449 of his 456 completions, so the fallback is genuinely the rare case.
   *
   *  Keyed by GIVER, matching accrueFromTitle and how computeRepBar looks it up. */
  private accrueFromContractKey(contractKey: string | null | undefined): boolean {
    if (!contractKey) return false;
    const m = this.dataset?.missions[contractKey];
    if (!m?.giver) return false;
    const pr = this.primaryRep(m);
    if (!pr) return false;
    const cur = this.repWitnessed.get(m.giver);
    if (cur && cur.scope === pr.scope) cur.sum += pr.amount;
    else this.repWitnessed.set(m.giver, { scope: pr.scope, sum: (cur?.sum ?? 0) + pr.amount });
    return true;
  }

  /** Exactly-once rep accrual for one completed mission.
   *
   *  🔑 One MISSION can raise three completion signals (see beginCompletion), so "has this
   *  completion already been credited" has to be answered by missionId against a PERSISTED set —
   *  not by whatever card happens to be on screen. Without that, every leaked repeat is a
   *  permanent over-count that survives every restart, and standing drifts upward forever.
   *  The set rides along with repWitnessed in both directions (persist, clear-on-verify) so the
   *  two can never disagree about what has been counted.
   *
   *  `contractKey` resolves the exact variant and is preferred; the title index is the fallback
   *  for the few completions with no marker (see accrueFromContractKey). */
  private accrueForCompletion(
    missionId: string | null,
    title: string | null | undefined,
    contractKey?: string | null,
  ): void {
    // No missionId means this credit could never be recognised as already-counted, and an
    // uncountable credit is how the over-count happened in the first place. Skipping it costs
    // effectively nothing — measured over Sub's 291 PUB logs, requiring an id changes no giver's
    // total — and the estimate is documented as a lower bound anyway.
    if (!missionId) return;
    if (this.repAccruedMissionIds.has(missionId)) return;
    // 🔑 Record the id only if something was CREDITED. Marking it up-front looks equivalent and
    // is not: a completion whose title the index cannot resolve YET — no dataset loaded, patch not
    // detected, an ambiguous title — would be marked spent and could never be credited afterwards.
    // Caught by running the real verifyFromLogs into a throwaway profile with no dataset: 388
    // completions "spent", every giver total zero, which is indistinguishable from the recovery
    // simply not working — i.e. exactly the symptom this fix exists to remove.
    if (this.accrueFromContractKey(contractKey) || this.accrueFromTitle(title)) {
      this.repAccruedMissionIds.add(missionId);
    }
  }

  /** Per-hour aUEC + rep for the idle screen, computed from the PERSISTED completion history
   *  (so it survives app restarts and counts retroactively — the in-memory version reset every
   *  relaunch). Each entry's rep is resolved from its mission title; aUEC is the logged award
   *  (usually null now — the game stopped logging payouts, so it shows "—"). Two readouts: the
   *  actual last rolling 60 min, and an extrapolated pace over the current grind session (the
   *  most-recent contiguous run of completions with gaps < SESSION_GAP_MS). */
  private earningRates(): EarningRates {
    const now = Date.now();
    const HOUR = 3_600_000;
    // 🔑 Same key-before-title order as accrueForCompletion, or this readout disagrees with the
    // bar it sits next to — a templated title ("Need a death at [Location]") reads 0 rep/hr while
    // the ladder correctly moves. History entries carry no key, so it comes from the still-known
    // mission; both windows here are recent by construction, which is exactly when that holds.
    const repOf = (m: MissionHistoryEntry): number => {
      const ck = m.missionId ? this.missions.get(m.missionId)?.contractKey : undefined;
      const byKey = ck ? this.primaryRep(this.dataset?.missions[ck])?.amount : undefined;
      return byKey ?? (m.title ? this.repTitleIndex.get(normScreenTitle(m.title))?.amount : 0) ?? 0;
    };
    const rows = this.missionHistory
      .map((m) => ({ atMs: Date.parse(m.at), aUEC: m.aUEC, rep: repOf(m) }))
      .filter((r) => Number.isFinite(r.atMs))
      .sort((a, b) => b.atMs - a.atMs); // newest first
    // Actual last rolling 60 minutes.
    const within = rows.filter((r) => now - r.atMs <= HOUR);
    const repLastHr = within.reduce((s, r) => s + r.rep, 0);
    const aUECknown = within.filter((r) => r.aUEC != null);
    const aUECLastHr = aUECknown.length ? aUECknown.reduce((s, r) => s + (r.aUEC ?? 0), 0) : null;
    // Current grind session = the most-recent contiguous run (break on a > SESSION_GAP_MS gap).
    const session: { atMs: number; aUEC: number | null; rep: number }[] = [];
    for (const r of rows) {
      if (session.length && session[session.length - 1].atMs - r.atMs > SESSION_GAP_MS) break;
      session.push(r);
    }
    // Pace = your ACTIVE grind rate = session earnings ÷ the span you were completing (newest −
    // oldest), so an idle stretch after the grind doesn't dilute it. Needs ≥2 to have a span.
    let repPace: number | null = null, aUECPace: number | null = null;
    if (session.length >= 2) {
      const spanHr = Math.max((session[0].atMs - session[session.length - 1].atMs) / HOUR, 60_000 / HOUR);
      repPace = Math.round(session.reduce((s, r) => s + r.rep, 0) / spanHr);
      const known = session.filter((r) => r.aUEC != null);
      aUECPace = known.length ? Math.round(known.reduce((s, r) => s + (r.aUEC ?? 0), 0) / spanHr) : null;
    }
    // Show the block while a grind is recent (last completion within SHOW_MS), even if the
    // rolling 60 min has since emptied — so you still see your last grind's pace.
    const SHOW_MS = 90 * 60_000;
    // What the session has actually been WORTH, as opposed to what it is running at. The idle
    // panel leads its scoreboard with this, and a rate is not a total: "148k an hour" answers a
    // different question from "148k earned". Known payouts only, and null rather than 0 when the
    // game logged none — the calculated-reward contracts genuinely do not report one.
    const sessionKnown = session.filter((r) => r.aUEC != null);
    const aUECTotal = sessionKnown.length
      ? Math.round(sessionKnown.reduce((s, r) => s + (r.aUEC ?? 0), 0))
      : null;
    const repTotal = Math.round(session.reduce((s, r) => s + r.rep, 0));
    return {
      repLastHr: Math.round(repLastHr),
      repPace,
      aUECLastHr: aUECLastHr != null ? Math.round(aUECLastHr) : null,
      aUECPace,
      aUECTotal,
      repTotal,
      missions: rows.filter((r) => now - r.atMs <= SHOW_MS).length,
    };
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
    // What reaching the next rank actually hands over. Battaglia gates SHIPS this way and the
    // panel never mentioned them, so the bar was a number with no stated reason to care.
    const nextRewards = pos.nextRank == null ? [] : (this.rewardsByRank(giver).get(pos.nextRank) ?? []);
    return { scope: primary.scope, faction: giver, ...pos, nextRewards };
  }

  /** Rank index -> item names for one giver, built once and cached. Mirrors how giverTrack()
   *  derives its reward ladder (a mission's `items` belong to that mission's rank). */
  private rewardsByRank(giver: string): Map<number, string[]> {
    const key = norm(giver);
    const hit = this.rankRewards.get(key);
    if (hit) return hit;
    const out = new Map<number, string[]>();
    for (const m of Object.values(this.dataset?.missions ?? {})) {
      if (!m.giver || norm(m.giver) !== key) continue;
      if (typeof m.rank !== "number") continue;
      const names = (m.items ?? []).map((i) => i.name).filter(Boolean);
      if (!names.length) continue;
      const at = out.get(m.rank) ?? [];
      for (const n of names) if (!at.includes(n)) at.push(n);
      out.set(m.rank, at);
    }
    this.rankRewards.set(key, out);
    return out;
  }

  /** Build a mission giver's full grind track: their standing ladder, your position on it, and
   *  every mission/reward grouped by the rank that gates it. The dataset's per-mission `rank` is
   *  the giver's standing tier, which lines up 1:1 with the rep scope's rank ladder — that's how
   *  the rank-gated ships (Golem @3, Prospector @4, MOLE @5) are surfaced. Returns null when the
   *  giver has no missions or no usable rep scope in the loaded dataset. */
  /** Title / giver / type for every contract in the loaded dataset, for matching a row
   *  read off the mobiGlas board back to a debug_name. Exposed rather than handing out
   *  `dataset` so the payout scanner can't reach into anything else, and so it follows
   *  whatever patch the tracker resolved instead of loading its own copy. */
  matchCandidates(): { debugName: string; title: string; giver: string; missionType: string }[] {
    if (!this.dataset) return [];
    return Object.entries(this.dataset.missions).map(([debugName, m]) => ({
      debugName,
      title: m.title ?? "",
      giver: m.giver ?? "",
      missionType: m.missionType ?? "",
    }));
  }

  giverTrack(giver: string): GrindTrack | null {
    if (!this.dataset) return null;
    const want = norm(giver);
    const entries = Object.entries(this.dataset.missions).filter(([, m]) => m.giver && norm(m.giver) === want);
    if (!entries.length) return null;

    // The scope every mission on this track reports (they all share the giver's standing).
    let scope = "";
    for (const [, m] of entries) {
      const pr = this.primaryRep(m);
      if (pr) { scope = pr.scope; break; }
    }
    if (!scope) return null;

    const toMission = ([key, m]: [string, DatasetMission]): GrindMission => ({
      key,
      title: m.title,
      rank: typeof m.rank === "number" ? m.rank : null,
      rep: this.primaryRep(m)?.amount ?? 0,
      // Key match is authoritative. Fall back to the title ONLY when this mission's key has never
      // been seen completed, and flag it so the UI can be honest about the ambiguity.
      completed: this.completedKeys.get(key) ?? this.completedTitles.get(normScreenTitle(m.title)) ?? 0,
      byTitleOnly: !this.completedKeys.has(key) && (this.completedTitles.get(normScreenTitle(m.title)) ?? 0) > 0,
      poolCount: Object.values(m.pools ?? {}).reduce((s, p) => s + p.length, 0),
      items: (m.items ?? []).map((i) => ({ name: i.name, amount: i.amount ?? 1 })),
    });
    const missions = entries.map(toMission);

    const ladder = [...(this.repScopes[scope]?.ranks ?? [])].sort((a, b) => a.minRep - b.minRep);
    const ranks = ladder.map((r, i) => ({
      rank: i,
      name: r.name,
      minRep: r.minRep,
      missions: missions.filter((m) => m.rank === i).sort((a, b) => b.rep - a.rep || a.title.localeCompare(b.title)),
    }));

    const rewards = missions
      .flatMap((m) => m.items.map((it) => ({ ...it, rank: m.rank, mission: m.title, received: m.completed > 0, unsure: m.completed > 0 && m.byTitleOnly })))
      .sort((a, b) => (a.rank ?? -1) - (b.rank ?? -1) || a.name.localeCompare(b.name));

    const pos = repLadderPosition(this.repScopes[scope], this.repWitnessed.get(giver)?.sum ?? 0);
    const canonical = entries[0][1].giver || giver; // dataset spelling wins; fall back to the query
    return {
      faction: canonical,
      scope,
      // Same shape the panel gets, including what the next rank unlocks — an empty nextRewards
      // here while the panel's is populated would just be a trap for the next reader.
      bar: pos
        ? { scope, faction: canonical, ...pos,
            nextRewards: rewards.filter((r) => r.rank === pos.nextRank).map((r) => r.name) }
        : null,
      ranks,
      reachedRank: this.inferredRank.get(canonical) ?? this.inferredRank.get(giver) ?? -1,
      intro: missions.filter((m) => m.rank == null).sort((a, b) => a.title.localeCompare(b.title)),
      rewards,
    };
  }

  /** Every giver's witnessed standing, and how many completions it was built from.
   *
   *  🔑 Exists because "my standing says Prestige 3 and I'm not" took a full log audit to pin
   *  down, and the two numbers that would have answered it in seconds — the stored sum and the
   *  count of completions behind it — were not visible anywhere. A sum wildly out of proportion
   *  to the count is the signature of an accrual leak; without the count, the sum alone tells
   *  you nothing. Surfaced through Copy diagnostics so a user can paste it. */
  repDiagnostics(): { creditedCompletions: number; givers: { giver: string; scope: string; sum: number; standing: string | null }[] } {
    const givers = [...this.repWitnessed.entries()]
      .map(([giver, v]) => ({
        giver, scope: v.scope, sum: v.sum,
        standing: repLadderPosition(this.repScopes[v.scope], v.sum)?.standing ?? null,
      }))
      .sort((a, b) => b.sum - a.sum);
    return { creditedCompletions: this.repAccruedMissionIds.size, givers };
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
    // 🔑 THE NEWEST ACCEPTED MISSION WINS, pool or no pool (Sub, 2026-08-13). This used to skip
    // straight past anything without a blueprint pool — a deliberate choice, so a cargo haul
    // accepted after a blueprint mission couldn't hide it. In practice that meant accepting a
    // bounty and watching the panel keep showing something else, with no hint why: *"we need to
    // have it come up and say no blueprint reward, and give more information about missions that
    // don't have blueprints."*
    // The pool-less view already earns its place — faction, rank, reputation, payout, item
    // rewards, and a plain line saying it drops no blueprints — so following the mission you
    // actually accepted is now more useful than protecting the one you didn't.
    // ⚠️ The cost, stated: a mission with no blueprints DOES now displace one with them. The
    // title is the picker, so getting back is one click — and pinning it makes the choice stick.
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

  /** DEV REPLAY ONLY: force the report's blueprint tiles for the CURRENT completion.
   *
   *  🔑 Why this is needed rather than just replaying a receipt: the replay may only "receive" a
   *  blueprint the player already owns (see ownedPoolBlueprint), and `noteReceiptTime` keeps the
   *  EARLIEST receipt — correctly, since an unlock date should be the first time you got it. So a
   *  replayed receipt can never move that date into the simulated mission's accept→complete
   *  window, and `completionBlueprints()` rightly returns nothing once the real receipt ages out.
   *  The tiles would then silently vanish from every simulation, which is precisely the thing the
   *  simulator exists to let you look at.
   *
   *  Display-only: no date is changed, nothing is persisted, nothing syncs. Cleared when the
   *  completion clears or is replaced. */
  forceCompletionBlueprints(names: string[]): void {
    this.forcedBlueprints = names.length ? names.map((n) => this.blueprintReward(n)) : null;
    this.emit("change");
  }

  /** A blueprint from this mission's pool that the player ALREADY owns, or null if they own
   *  none of it. Exists for the dev replay (`src/dev-replay.ts`): a simulated "Received
   *  Blueprint" goes through the SAME path as a real one, so it mutates the real collection and
   *  SiteSync then pushes that collection with `replace:true`. Re-receiving something already
   *  owned is a no-op against a set; inventing a new one would write a lie to the website. */
  ownedPoolBlueprint(contractKey: string): string | null {
    const m = this.dataset?.missions[contractKey];
    if (!m) return null;
    for (const entries of Object.values(m.pools ?? {})) {
      for (const e of entries) if (this.isOwned(e.blueprint).owned) return e.blueprint;
    }
    return null;
  }

  private isOwned(poolName: string): { owned: boolean; source: BlueprintSource } {
    // Explicit manual override on the exact pool name wins (owned or not-owned).
    // 🔑 …for the ANSWER, not for the PROVENANCE. An override's job is to change whether you own
    // something, never to rewrite how it was found. Sub, 2026-08-13: he had a real log receipt for
    // the Ripper Sunblock SMG, un-ticked it by accident, ticked it back, and the row then read
    // "[manual]" — "now it's lying to me". The receipt never went anywhere; it was just shadowed
    // by the override sitting in front of it. So a POSITIVE override defers to the log when the
    // log has something to say, and only claims "manual" when it is genuinely the only evidence.
    // A NEGATIVE override still wins outright — saying "I don't have this" is the whole point of
    // un-ticking, and the receipt must not drag it back.
    if (this.overrides.has(poolName)) {
      const v = this.overrides.get(poolName)!;
      if (!v) return { owned: false, source: null };
      if (matchesPoolName(poolName, this.observed)) return { owned: true, source: "in-game" };
      if (matchesPoolName(poolName, this.fabOwned)) return { owned: true, source: "fab" };
      return { owned: true, source: "manual" };
    }
    // Earned in-game (an observed receipt, incl. a variant) — most specific.
    if (matchesPoolName(poolName, this.observed)) return { owned: true, source: "in-game" };
    // Confirmed at the fabricator. Ranked ABOVE a plain manual tick because the game was
    // displaying the item at the time, and below an actual receipt, which is proof.
    if (matchesPoolName(poolName, this.fabOwned)) return { owned: true, source: "fab" };
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

  /** Last resort: the log and the dataset sometimes WORD THE SAME ITEM DIFFERENTLY.
   *  The log's `BlackFire Racing Flight Suit` is the dataset's
   *  `Neutrino Racing Flight Suit BlackFire` — the colour moves from suffix to prefix
   *  and the manufacturer is dropped, so neither an exact nor a prefix match can ever
   *  fire. Match on the TOKEN SET instead of word order.
   *
   *  🔑 Only ever returns a result when EXACTLY ONE item contains every token the
   *  receipt used. Ambiguity is never guessed: an unresolved receipt costs one missing
   *  tick, a wrongly-resolved one silently writes someone else's item into a player's
   *  synced collection. Single-token receipts are refused outright — "Arclight" is a
   *  subset of every Arclight variant and would resolve by luck. */
  private resolveTokens(target: string, entries: Iterable<{ name: string; item: string | null }>): string[] {
    const want = target.split(" ").filter(Boolean);
    if (want.length < 2) return [];
    const hits = new Set<string>();
    for (const e of entries) {
      if (!e.item) continue;
      const have = new Set(norm(e.name).split(" ").filter(Boolean));
      if (want.every((w) => have.has(w))) {
        hits.add(e.item);
        if (hits.size > 1) return []; // ambiguous — refuse rather than pick
      }
    }
    return [...hits];
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
    if (direct.length) return this.preferCatalog(direct);
    // Fallback: SC ship-component designation ("Mil/2/B Bolide", `STL-1B "Zephyr"`) →
    // the bare model the dataset stores ("Bolide", "Zephyr").
    const model = componentModel(received);
    if (model) {
      const byModel = this.resolveName(norm(model), entries);
      if (byModel.length) return this.preferCatalog(byModel);
    }
    // Word-order variants ("BlackFire Racing Flight Suit" vs the dataset's
    // "Neutrino Racing Flight Suit BlackFire"). Unique matches only.
    return this.resolveTokens(norm(received), entries);
  }

  /** A handful of names exist in mission POOLS under a UUID that is not the catalog's
   *  ("Cinch Scraper Module", "Antium Core Jet", "BroadSpec"). Callers that need ONE
   *  uuid take `[0]`, so which one wins was down to iteration order — and picking the
   *  pool-only uuid syncs an item the site cannot render (it is absent from `index`,
   *  so it has no name, image or page). Prefer the catalog uuid whenever the name
   *  resolves to more than one. */
  private preferCatalog(uuids: string[]): string[] {
    if (uuids.length < 2 || !this.dataset?.index) return uuids;
    const inIndex = new Set(this.dataset.index.map((e) => e.item));
    const known = uuids.filter((u) => inIndex.has(u));
    return known.length ? known : uuids;
  }

  /** Crafting detail (recipe / dismantle / craft time / stats / manufacturer) for a
   *  blueprint, given EITHER its output item UUID or a blueprint NAME. A name is resolved
   *  to a UUID through the same variant-aware index as ownership (itemUuidsForName), then
   *  looked up in the detail dataset. Returns null when the detail file isn't loaded or
   *  the blueprint has no recipe on record. Reachable by the overlay via the server's
   *  /api/blueprint-detail endpoint. */
  /** Blueprint names DISTINCTIVE enough to link on sight in chat, without anyone asking for it
   *  (Sub, 2026-08-09: "nobody typing those letters in that order means anything else").
   *
   *  🔑 The whole risk is over-linking. Of 1,572 blueprint names, 301 are a single word and 24
   *  are under five characters — among them `Bolt`, `Echo`, `Nova`, `INK`, `PIN` and `HEX`,
   *  which are ordinary chat words. Turning those into links would make the feature feel broken
   *  and would put a wrong link in front of the reader. So a name auto-links only when it cannot
   *  plausibly be ordinary English:
   *    · more than one word          ("Geist Armor Arms")      — always distinctive
   *    · or contains a digit         ("DebBolt3", "10-Series") — Sub's own example
   *    · or is camelCase             ("AbsoluteZero")          — a capital after the first letter
   *    · or is >= 6 letters and not a common word ("Agrippa")
   *  Anything shorter or word-like is still reachable through /bp, which is explicit. */
  autoLinkNames(): { match: string; name: string; item: string }[] {
    const idx = this.dataset?.index;
    if (!idx) return [];
    // Words that ARE blueprint names but are also things people say. Kept small on purpose —
    // it only has to cover names that survive the shape rules above.
    const COMMON = new Set([
      "bolt", "echo", "nova", "endo", "eos", "kama", "ink", "pin", "hex", "bloc", "agni",
      "ezra", "salvo", "surge", "spirit", "flash", "frost", "ghost", "hammer", "shield",
      "cooler", "armor", "helmet", "light", "medium", "heavy", "core", "arms", "legs",
      "power", "quantum", "radar", "scraper", "storm", "sentry", "shard", "global",
    ]);
    // 🔑 People do not type names the way the game files spell them. The real item is
    // "Deadbolt III Cannon"; Sub reached for "DebBolt3" from memory, and a player will type
    // "Deadbolt 3". So each name also matches with its ROMAN numeral written as a digit, and
    // without the trailing category word ("… Cannon"). Both aliases still resolve to the one
    // canonical name, so the link is never ambiguous.
    const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
    const TRAILING = /\s+(Cannon|Repeater|Scattergun|Helmet|Core|Arms|Legs|Undersuit|Backpack|Module|Rifle|Pistol|SMG|Shotgun|LMG|Sniper)$/i;
    const out: { match: string; name: string; item: string }[] = [];
    const seen = new Set<string>();
    // 🔑 The site's blueprint page is /blueprints/<ITEM UUID>, not the name — a name-based link
    // 404s (measured against production). The uuid rides with every entry so the widget never
    // has to guess.
    const push = (match: string, name: string, item: string) => {
      const l = match.toLowerCase();
      if (!match || match.length < 4 || seen.has(l) || COMMON.has(l) || !item) return;
      seen.add(l);
      out.push({ match, name, item });
    };
    for (const e of idx) {
      const n = (e.name ?? "").trim();
      const uuid = e.item ?? "";
      if (!n || n.length < 4 || !uuid) continue;
      const multiWord = /\s/.test(n);
      const hasDigit = /\d/.test(n);
      const camel = /^[A-Za-z][a-z]+[A-Z]/.test(n);
      const longEnough = /^[A-Za-z'’-]{6,}$/.test(n);
      if (!(multiWord || hasDigit || camel || longEnough)) continue;
      push(n, n, uuid);
      // "Deadbolt III Cannon" → also match "Deadbolt 3 Cannon" and "Deadbolt 3".
      const arabic = n.replace(/\b([ivx]+)\b/gi, (w) => ROMAN[w.toLowerCase()] ?? w);
      if (arabic !== n) push(arabic, n, uuid);
      for (const variant of [n, arabic]) {
        const stem = variant.replace(TRAILING, "");
        // Only when the stem still carries something distinctive of its own — a bare
        // "Deadbolt" could be any mark, and a link that picks one silently is worse than none.
        if (stem !== variant && /\d/.test(stem)) push(stem, n, uuid);
      }
    }
    // Longest first, so "Geist Armor Arms" wins over "Geist Armor" when both match.
    return out.sort((a, b) => b.match.length - a.match.length);
  }

  /** Blueprint names matching a typed fragment, for the chat widget's /bp autocomplete.
   *  Reads `dataset.index` — the global name→uuid index of EVERY blueprint in the game, not
   *  just the ones in mission pools, which is what makes it usable as a lookup rather than a
   *  list of what you happen to be running. Prefix matches rank above contains-matches, so
   *  typing "geist" offers "Geist Armor…" before "…Geist variant". */
  searchBlueprintNames(q: string, limit = 8): { name: string; item: string }[] {
    const needle = q.trim().toLowerCase();
    if (!needle || !this.dataset?.index) return [];
    const seen = new Set<string>();
    const starts: { name: string; item: string }[] = [];
    const has: { name: string; item: string }[] = [];
    for (const e of this.dataset.index) {
      const name = e.name;
      if (!name || !e.item) continue;
      const l = name.toLowerCase();
      if (seen.has(l)) continue;
      if (l.startsWith(needle)) { seen.add(l); starts.push({ name, item: e.item }); }
      else if (l.includes(needle)) { seen.add(l); has.push({ name, item: e.item }); }
      if (starts.length >= limit) break;
    }
    return [...starts, ...has].slice(0, limit);
  }

  /** Mission TITLES matching a fragment, for the chat widget's /mission command — "hey, I want
   *  to run this" with a link back to the site's mission page (/missions/<contract key>).
   *  🔑 Titles are not unique (the same title exists as a one-time intro and a repeatable rank
   *  contract), so the KEY is what the link carries and the title is only what it reads as. */
  searchMissionTitles(q: string, limit = 8): { title: string; key: string }[] {
    const needle = q.trim().toLowerCase();
    const missions = this.dataset?.missions;
    if (!needle || !missions) return [];
    const seen = new Set<string>();
    const starts: { title: string; key: string }[] = [];
    const has: { title: string; key: string }[] = [];
    for (const [key, m] of Object.entries(missions)) {
      const title = (m.title ?? "").trim();
      if (!title) continue;
      const l = title.toLowerCase();
      if (seen.has(l)) continue;
      if (l.startsWith(needle)) { seen.add(l); starts.push({ title, key }); }
      else if (l.includes(needle)) { seen.add(l); has.push({ title, key }); }
      if (starts.length >= limit) break;
    }
    return [...starts, ...has].slice(0, limit);
  }

  blueprintDetail(nameOrUuid: string): BlueprintDetail | null {
    if (!nameOrUuid) return null;
    // A UUID-shaped argument is looked up directly; otherwise resolve the name → UUID(s).
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nameOrUuid);
    const uuids = isUuid ? [nameOrUuid] : this.itemUuidsForName(nameOrUuid);
    for (const u of uuids) {
      const d = this.detail.get(u);
      if (d) return d;
    }
    return null;
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
  collectedItemsWithDates(): { uuid: string; unlockedAt: string | null; source: SyncSource }[] {
    // "fab" outranks "manual": the game was displaying the item when the player confirmed it.
    const RANK = { default: 1, manual: 2, fab: 3, "in-game": 4 } as const;
    const map = new Map<string, { unlockedAt: string | null; source: SyncSource }>();
    const consider = (uuid: string, ts: string | null, source: SyncSource) => {
      const cur = map.get(uuid);
      if (!cur) {
        map.set(uuid, { unlockedAt: ts, source });
        return;
      }
      // Keep the strongest source (in-game > fab > manual > default) + earliest unlock time.
      if (RANK[source] > RANK[cur.source]) cur.source = source;
      if (ts && (cur.unlockedAt == null || Date.parse(ts) < Date.parse(cur.unlockedAt))) cur.unlockedAt = ts;
    };
    // Add low→high so a stronger source upgrades the same uuid (defaults first).
    for (const d of this.dataset?.defaults ?? []) if (d.item) consider(d.item, null, "default");
    for (const [name, val] of this.overrides) {
      if (val) for (const u of this.itemUuidsForName(name)) consider(u, null, "manual");
    }
    for (const name of this.fabOwned) {
      for (const u of this.itemUuidsForName(name)) consider(u, null, "fab");
    }
    for (const name of this.observed) {
      const ts = this.observedAt.get(name) ?? null;
      for (const u of this.itemUuidsForName(name)) consider(u, ts, "in-game");
    }
    return [...map].map(([uuid, v]) => ({ uuid, unlockedAt: v.unlockedAt, source: v.source }));
  }

  /** The tracked mission's dataset key (debug_name), or null once it's ended
   *  (completed/abandoned). Gating on endedMissionIds is what stops the site's
   *  "currently tracking" from sticking on a mission you just dropped — the
   *  overlay already hides it via effectiveMissionId, but the sync read this
   *  pointer raw. */
  currentContractKey(): string | null {
    if (!this.trackedMissionId || this.endedMissionIds.has(this.trackedMissionId)) return null;
    const t = this.missions.get(this.trackedMissionId);
    return t?.contractKey ?? null;
  }

  /** The detected build changelist (or the loaded dataset's), or null. */
  currentChangelist(): string | null {
    return this.detectedChangelist ?? this.dataset?.changelist ?? null;
  }

  // ---- view for the overlay ----

  /** The pools of same-title variants that are NOT the one being shown — the drops you cannot
   *  get from where you took this contract.
   *
   *  🔑 Compared by pool CONTENT, never by variant count. 540 titles have several variants but
   *  only 80 have variants whose pools actually differ; the other 460 are the same pool offered
   *  in several places, and telling someone to fly across the system for blueprints they can
   *  already win here would be worse than saying nothing.
   *
   *  Returns nothing while AMBIGUOUS: the panel is already showing the union of every candidate,
   *  so "other pools" would be the pools it is currently displaying.
   */
  private otherPoolsFor(
    key: string | null,
    mission: DatasetMission | undefined,
    ambiguous: boolean,
  ): { places: string[]; total: number; owned: number }[] {
    if (ambiguous || !key || !mission?.title || !this.dataset) return [];
    const sig = (m: DatasetMission): string =>
      Object.values(m.pools ?? {})
        .map((entries) => entries.map((e) => e.blueprint).sort().join("|"))
        .sort()
        .join(" || ");
    const mine = sig(mission);
    if (!mine) return [];
    const out: { places: string[]; total: number; owned: number }[] = [];
    const seen = new Set<string>([mine]);
    for (const [k, m] of Object.entries(this.dataset.missions)) {
      if (k === key || m.title !== mission.title) continue;
      const s = sig(m);
      // Dedupe by CONTENT: several regions can share one alternative pool, and listing it twice
      // would read as two separate trips.
      if (!s || seen.has(s)) continue;
      seen.add(s);
      let total = 0, owned = 0;
      for (const entries of Object.values(m.pools ?? {})) {
        for (const e of entries) { total++; if (this.isOwned(e.blueprint).owned) owned++; }
      }
      if (total) out.push({ places: m.where ?? [], total, owned });
    }
    return out;
  }

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
          return {
            name: e.blueprint, owned: o.owned, source: o.source, chance: e.chance,
            tab: cat.tab, sub: cat.sub,
            item: e.item ?? null, hasDetail: !!this.detail.get(e.item),
          };
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
      payoutEstimated: mission?.payoutCalculated === true,
      itemRewards: (mission?.items ?? []).map((i) => ({
        name: i.name,
        amount: Number(i.amount) || 1,
        owned: this.guaranteedOwned.has(i.name),
      })),
      giver: mission?.giver ?? null,
      inferredRank: mission?.giver ? this.inferredRank.get(mission.giver) ?? null : null,
      repBar: this.computeRepBar(mission),
      missionType: mission?.missionType ?? null,
      // Suppressed while ambiguous on purpose: the candidates are offered in different
      // regions that draw from DIFFERENT pools, so listing all their places would point
      // the player at somewhere that cannot drop what the panel is showing.
      whereToGet: ambiguous ? [] : mission?.where ?? [],
      illegal: mission?.illegal === true,
      rankRequired: mission?.rank ?? null,
      rankRequiredName: this.rankName(mission),
      otherPools: this.otherPoolsFor(key, mission, ambiguous),
      reputationGained: mission?.reputationGained ?? [],
      reputationLost: mission?.reputationLost ?? [],
      eventTrack,
      completed: holdActive || (effectiveId ? this.completedMissionIds.has(effectiveId) : false),
      pools,
      totals: { owned, total },
      // 🔑 The SAME set the site sync uploads, so the widget and subliminal.gg can never disagree.
      // This used to be `observed.size + overrides(true).length`, which counted only two of the
      // FOUR ownership sources — it silently dropped starter-gear defaults (8 items) and every
      // fabricator-confirmed tick. Sub read 169 in the widget against 178 on the site and the
      // natural conclusion was that sync was broken. Counting NAMES against the site's UUIDs was
      // the second half of the same mismatch (harmless today — no name maps to two UUIDs — but
      // it was one dataset change away from drifting again).
      collectedTotal: this.collectedItemsWithDates().length,
      recentMissions: this.recentMissions(),
      recentBlueprints: this.recentBlueprints(),
      closestPools: this.closestPools(),
      earnings: this.earningRates(),
      justReceived: this.justReceived,
      completion: holdActive
        ? {
            title: this.completion!.title ?? mission?.title ?? tracked?.title ?? null,
            aUEC: this.completion!.aUEC,
            payout: this.completion!.payout,
            durationMs: this.completion!.acceptedAtMs != null ? this.completion!.completedAtMs - this.completion!.acceptedAtMs : null,
            blueprints: this.forcedBlueprints ?? this.completionBlueprints(),
            // During the hold, `effectiveId` IS the completed mission (see holdActive above),
            // so `key`, `mission`, `owned` and `total` in this scope already describe it —
            // which is what makes the report independent of whatever the player had pinned.
            at: new Date(this.completion!.completedAtMs).toISOString(),
            contractKey: key,
            giver: mission?.giver ?? null,
            missionType: mission?.missionType ?? null,
            rank: mission?.rank ?? null,
            reputationGained: mission?.reputationGained ?? [],
            aUecPerHour: this.completionRate(),
            timesCompleted: key ? this.completedKeys.get(contractKeyOf(key)) ?? null : null,
            poolProgress: total > 0 ? { owned, total } : null,
            classification: classifyMission({ generatorClass: mission?.generatorClass, missionType: mission?.missionType }),
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
      this.fabOwned = new Set(data.fabOwned ?? []);
      this.inferredRank = new Map(Object.entries(data.inferredRank ?? {}));
      this.repWitnessed = new Map(Object.entries(data.repWitnessed ?? {}));
      this.repAccruedMissionIds = new Set(data.repAccruedMissionIds ?? []);
      this.completedTitles = new Map(Object.entries(data.completedTitles ?? {}));
      this.completedKeys = new Map(Object.entries(data.completedKeys ?? {}));
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
      fabOwned: [...this.fabOwned],
      inferredRank: Object.fromEntries(this.inferredRank),
      repWitnessed: Object.fromEntries(this.repWitnessed),
      repAccruedMissionIds: [...this.repAccruedMissionIds],
      completedTitles: Object.fromEntries(this.completedTitles),
      completedKeys: Object.fromEntries(this.completedKeys),
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
