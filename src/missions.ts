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
import { Phrasebook, type PhrasebookInfo } from "./localization.js";
import type { SyncSource } from "./sync.js";
import {
  tiersCrossed, receiptForCrossing, candidateForTier, isPromptDue, shouldAsk,
  RECEIPT_WINDOW_MS, PROMPT_DWELL_MS,
  type ReceiptNote, type RewardPrompt, type PromptAnswerSource,
} from "./event-rewards.js";

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
/** A started-but-unfinished blueprint POOL, for the idle panel's "closest to done" list.
 *
 *  🔴 THE UNIT IS THE POOL, NOT THE MISSION — changed 2026-08-15, and it was a real bug. This list
 *  used to iterate contracts, so a pool fed by many contracts filled the panel with itself: Sub saw
 *  four rows that were four TITLES of one pool (`819a9851…`, United Wayfarers Club refuelling),
 *  all reading 5/8, where he should have seen four different pools. The old dedupe keyed on
 *  title + progress and could not catch it, because the titles genuinely differ.
 *  Measured over 4.9.0-LIVE.12344265: **89 distinct pools** behind 755 pool-bearing contracts, and
 *  **65 of the 89 span more than one title** — so this is the normal case, not an edge case. That
 *  one refuelling pool has **79 contract variants across 5 titles**.
 *
 *  🔑 A pool has ONE identity and it is `poolUuid`. That is also the key the website's pool page is
 *  addressed by, so the widget can link straight out to it.
 *
 *  🔑 The cost/reward fields are measured and deliberately left UN-RENDERED (Sub, 2026-08-15: the
 *  per-hour figure belongs to the session tracker, "not with the closest to done"). They are kept
 *  because they are cheap and already computed; do not tidy them away, and do not render them
 *  without asking. Coverage over the 755 contracts: 748 carry a payout AND a run length, 726 a
 *  reputation award, 377 a re-accept cooldown. Where a pool's contracts disagree, the value is the
 *  representative contract's — these describe ONE run of ONE contract, never the pool as a whole. */
export interface ClosestPool {
  /** The pool's own uuid — its identity, and the key the website's pool page uses. */
  poolUuid: string;
  /** A representative contract key, for anything that still needs to name a mission. */
  key: string;
  /** The representative contract's title — what the pool used to be called here. */
  title: string;
  /** A readable name for the POOL rather than for one of its contracts: giver + type, which is
   *  unambiguous for 85 of 89 pools (one giver) and 77 (one type). Falls back to the
   *  representative title when the pool's contracts disagree, so it is never a half-truth. */
  poolName: string;
  /** Every distinct contract title that feeds this pool, shortest first. The UI shows the first
   *  and offers the rest — "there are other ways to farm this" is the useful part. */
  missionTitles: string[];
  /** How many contract VARIANTS feed it (79 for the refuelling pool, not 5). */
  variants: number;
  /** The blueprints still missing from this pool, alphabetical — what "3 to go" actually means.
   *  🔑 Also the tie-breaker on the name: two DIFFERENT pools can share a giver and a type (Sub
   *  has two "Shubin Interstellar · Ship Mining" pools open, both mining lasers and radars, and
   *  even their contract titles collide), so a name alone would reintroduce the very repetition
   *  this restructure removed. What you still need is the thing that actually tells them apart. */
  missing: string[];
  owned: number;
  total: number;
  places: string[];
  /** Dataset payout for ONE completion, before the 5–20% standing bonus. Null when unlisted.
   *  min === max for the overwhelming majority; the UI shows a range only when they differ. */
  payMin: number | null;
  payMax: number | null;
  /** 🔴 TRUE FOR EVERY POOL CONTRACT MEASURED — all 748 with a payout are MODELLED, not read from
   *  the game files, because the game works these rewards out at accept time. So the idle panel's
   *  aUEC figures are estimates WITHOUT EXCEPTION and must carry the tilde + the circled i, the
   *  same treatment `payBlock()` gives the tracked mission. A rate built on this is a ballpark. */
  payoutEstimated: boolean;
  /** Expected minutes for one run (`dur` in mission-facts). Null when unlisted. */
  durMin: number | null;
  /** Reputation one completion awards, summed across scopes. Null when the contract lists none. */
  rep: number | null;
  /** Minutes before the same contract can be taken again (`cd`). Null when it has no cooldown.
   *  🔑 NOT `boardRespawnMin` — this is "when can I run it again", which is what caps the grind. */
  cooldownMin: number | null;
  /** Who gives it, and what kind of work it is — context for "do I want to spend an hour here". */
  giver: string | null;
  missionType: string | null;
}
/** Where you stand with ONE mission giver, for the idle panel's standings segment.
 *
 *  🔑 Built from what the app ALREADY tracks: `repWitnessed` (rep accrued per giver, rebuilt from
 *  the player's own logs) run through `repLadderPosition` against the giver's scope ladder — the
 *  same two pieces `computeRepBar` uses for the tracked mission, just for every giver at once.
 *  Measured on Sub's collection 2026-08-15: 9 givers carry witnessed rep, from Wikelo at 20 to
 *  Recco Battaglia at 24,700.
 *
 *  🔴 THE ESTIMATE IS A FLOOR, ALWAYS. The game never reports reputation anywhere the app can
 *  read, so this is reconstructed from completions in the logs and can only ever undercount —
 *  anything earned before the app was installed, or in a log since rotated away, is invisible.
 *  Every consumer must present it as an estimate, the same way the tracked mission's rep bar does. */
export interface FactionStanding {
  /** The giver, in the dataset's spelling. */
  faction: string;
  /** The rep scope driving the ladder (e.g. "FactionReputation"). */
  scope: string;
  /** Current rank NAME ("Sr. Contractor"), and the next one up (null at max). */
  standing: string;
  nextName: string | null;
  /** Estimated rep total (a floor), the current rank's floor, and the next rank's. */
  estimate: number;
  curMin: number;
  nextMin: number | null;
  /** How far through the CURRENT rank you are, 0-100. 100 at max rank. */
  pct: number;
  /** Rep still needed to reach `nextName`. Null at max rank. */
  toGo: number | null;
  /** 🔑 The rep-to-go expressed as CONTRACTS, using the median rep this giver's missions award —
   *  an abstract number turned into an action. Null when the giver has no scoreable missions, or
   *  at max rank. Always approximate: rep per contract varies with rank and difficulty. */
  contractsToGo: number | null;
  /** What reaching the next rank hands over (rank-gated ships and items). Often empty. */
  nextRewards: string[];
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
  /** 🔑 THIS CONTRACT WILL NOT MOVE THIS BAR. True when the contract pays its reputation into a
   *  track the app does not rank — REP_SCOPE_DENY excludes ShipCombat_*, FPS_Combat, Racing and
   *  friends, and 384 of 4,075 contracts pay ONLY those — so the standing shown is the giver's
   *  own, earned from their other work. The bar is still the right answer to "where do I stand
   *  with these people", but the panel must say that finishing THIS one will not advance it, or
   *  the number is a lie by implication sitting next to a +500 reputation pill. */
  offTrack?: boolean;
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
  /** What ONE run costs and pays. Measured over Recco Battaglia's 33 contracts on 2026-08-15:
   *  33 carry a payout, 32 a run length, 32 a difficulty, and only ONE a re-accept cooldown.
   *  🔑 This is what turns a grind tracker from a scoreboard into a route: rep per hour varies
   *  FOUR-FOLD across Battaglia's own missions (4,800/hr on "Extra Special Job" against 1,200/hr
   *  on most of the rank 0-2 work), so "which one do I run" has a real answer the widget could
   *  not previously give. Every field is optional and the UI must omit rather than invent. */
  payMax: number | null;
  /** 🔴 Always true in practice for these — the payout is MODELLED, not read from the game. */
  payoutEstimated: boolean;
  durMin: number | null;
  /** CIG's own blended difficulty, 1-7. */
  diff: number | null;
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

// ---- dynamic events (Siege of Orison / Return of XenoThreat) ----

/**
 * One dynamic event, as declared in the hand-maintained `data/events.json`.
 *
 * 🔑 **This is DATA, not code, and deliberately changelist-independent.** An event's tiers,
 * per-contract point values and rewards are discovered by PLAYING, not by extracting the p4k, so
 * the file has to survive dataset regeneration — the same reasoning as the site's
 * `blueprints-extra.json`, whose model this mirrors. Sub's ruling, 2026-08-19: *"Each event
 * tracker is going to have to be custom made depending on the event."* Orison Relief's tiers are
 * `15/25/43/57/80/100`; Return of XenoThreat's were `15/25/50/60/85/100`. **They differ, which is
 * the whole argument for tiers being data.**
 */
export interface EventDef {
  id: string;
  /** ⚠️ The subject of the game's OWN notification, verbatim: `Journal Entry Added: <log>: `.
   *  For Siege of Orison the game says **"Orison Relief"**; "Siege of Orison" is only the
   *  marketing name. Matching on the wrong one records zero progress, silently. */
  log: string;
  /** Display name. Intentionally allowed to differ from `log`. */
  label: string;
  status?: "upcoming" | "current" | "past";
  patch?: string | null;
  /** One-line note telling the player where to read their real % (their in-game Journal). */
  note?: string;
  /**
   * Dataset-key prefixes that identify this event's missions (`["ORS_"]`, `["RoX_"]`).
   *
   * 🔴 **THIS, NOT `generators`, IS WHAT SEPARATES TWO EVENTS.** CIG ships ONE generator —
   * `TheBackpocket` — for both Orison Relief (13 `ORS_` contracts) and Return of XenoThreat
   * (5 `RoX_`). The shipped code matched on the generator alone, so **10 of the 13 Orison
   * Relief contracts would have shown a player the XenoThreat reward ladder**, complete with a
   * note telling them to check "Journal → Return of XenoThreat". Measured against the real 4.9
   * dataset and real 4.10 markers, 2026-08-19.
   */
  contractPrefixes?: string[];
  /** Kept for recognising an event mission whose key we never saw, and as documentation of the
   *  shared generator. ⚠️ Never sufficient alone — see `contractPrefixes`. */
  generators?: string[];
  /** Event points needed for 100%, or null while unknown. */
  total?: number | null;
  /** Reward milestones as PERCENTAGES of `total`. */
  tiers?: number[];
  /** Dataset mission key -> event points that contract awards. Sparse on purpose: only
   *  measured values belong here, because an interpolated one becomes a wrong percentage. */
  contracts?: Record<string, number>;
  /** Tier rewards, filled in as they are seen. `name` must equal the log's
   *  `Received Blueprint: <name>` exactly, or the collected-tier bar can never light up. */
  rewards?: { tier: number; name: string; item?: string | null }[];
  /**
   * 🔴 UNCONFIRMED guesses at tier rewards — for Siege of Orison, five names relayed from a
   * viewer's chatbot answer. **They must NEVER render as a reward anywhere.** `EventProgress`
   * deliberately does not carry them, so no widget can reach one by accident.
   *
   * Their one sanctioned use is `src/event-rewards.ts`'s prompt, where the candidate is the
   * thing being ASKED ABOUT ("it looks like you received X — is that right?"). Answering is
   * exactly the mechanism that promotes a candidate to a measurement, which is why the guess
   * may appear inside the question and nowhere else.
   */
  rewardCandidates?: { tier: number; name: string; confirmed?: boolean }[];
}

/** One witnessed "this completion counted toward the event" observation. */
export interface EventContribution {
  /** Dataset mission key, when a marker resolved it. Null when only the title is known —
   *  recorded anyway, because an unattributed contribution is still evidence the event fired. */
  key: string | null;
  title: string | null;
  /** ISO-8601 from the log. */
  at: string;
  /** Points credited from `EventDef.contracts`, or null when that contract's value is not yet
   *  measured. 🔑 Null is NOT zero — it is "we saw progress we cannot price", and the view
   *  reports the two separately so an unpriced run never silently reads as no progress. */
  points: number | null;
}

/** The overlay-facing view of one event's track (the Event Tracker widget's tab). */
export interface EventProgress {
  id: string;
  label: string;
  log: string;
  status: "upcoming" | "current" | "past";
  total: number | null;
  /** Points from contributions we could price. A LOWER BOUND — same honesty policy as the rep
   *  bar, and for the same reason: the game never tells the client the number. */
  points: number;
  /** Percent of `total`, or null when `total` is unknown. */
  pct: number | null;
  /** Contributions seen whose contract value is not yet in events.json. If this is non-zero the
   *  percentage is an UNDER-count and the UI must say so. */
  unpriced: number;
  contributions: EventContribution[];
  tiers: { pct: number; points: number | null; reached: boolean; rewards: { name: string; item: string | null; owned: boolean }[] }[];
  /** True when the event declares no rewards yet — the widget shows "not yet known" rather
   *  than an empty list that reads like "no rewards". */
  rewardsUnknown: boolean;
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
  /** Resolved item UUID, or null when the name could not be placed. */
  item: string | null;
  /** The crowdsourced fabricator CAPTURE — what a player actually recognises. 404s for anything
   *  nobody has captured (coverage was 27% in 2026-07), so the client falls back. */
  image: string | null;
  /** The generated clay render: exists for ~70% more, but is grey, untextured and SHARED between
   *  items that reuse a model — so it can identify a shape, not always an item. */
  imageFallback: string | null;
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
  /** 🔴 True when any money figure this session came from the contract's LISTED payout rather than
   *  a logged award. Since current patches stopped emitting "Awarded N aUEC" entirely, this is
   *  true whenever there is a figure at all — so the UI must always be prepared to mark it. */
  aUECEstimated: boolean;
  /** True when any listed payout used above is itself MODELLED off the fitted curve rather than
   *  read from the game files. Wrong about one time in four, so it earns a stronger caveat than
   *  `aUECEstimated` alone. */
  aUECModelled: boolean;
  /** How many of this session's completions contributed a money figure. Shown so a total drawn
   *  from 3 of 20 contracts cannot read as the whole session's earnings. */
  aUECFrom: number;
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

/** The mission-search brief: a contract the player has NOT accepted, described with the same
 *  fields `missionInfoHtml()` already reads off a live view. See `previewByTitle()` for why it is
 *  keyed by title, why the scalars are agree-or-omit, and why the pool merge is not re-derived. */
export interface MissionPreview {
  contractKey: string | null;
  title: string;
  giver: string | null;
  missionType: string | null;
  illegal: boolean;
  rankRequired: number | null;
  rankRequiredName: string | null;
  payout: { min: number | null; max: number; currency: string | null } | null;
  payoutEstimated: boolean;
  reputationGained: RepEntry[];
  reputationLost: RepEntry[];
  whereToGet: string[];
  otherPools: { places: string[]; total: number; owned: number }[];
  inferredRank: number | null;
  repBar: RepBar | null;
  ambiguous: boolean;
  hasPool: boolean;
  /** Contract facts. Taken from the single variant only — see the note in previewByTitle. */
  facts: MissionFacts | null;
  /** How many dataset contracts share this title — shown so "1 of 253" is never a surprise. */
  variants: number;
  pools: { poolUuid: string; blueprints: BlueprintStatus[] }[];
  owned: number;
  total: number;
}

/** Contract facts from `mission-facts.<cl>.json`. Every field is optional — coverage runs 46–77%
 *  and a renderer must self-hide rather than print a blank. */
export interface MissionFacts {
  /** Minutes before you can take this contract again after finishing it (55%). */
  cd?: number;
  /** Variance on that wait, in minutes. */
  cdVar?: number;
  /** How long a run is expected to take, in minutes (47%). A DIFFERENT number from `cd`. */
  dur?: number;
  /** CIG's own blended difficulty, 1–7 (46%). */
  diff?: number;
  /** Only ever true: failing this contract locks you out of retaking it (77%).
   *  ⚠️ Absence means "not stated", never "you can retry" — assert only the negative. */
  noRetry?: boolean;
}

export interface TrackedView {
  /** The loaded dataset's version (the pools being shown). */
  patch: string | null;
  /** The player's actual build changelist from the log (may differ from the dataset
   *  if their exact build isn't bundled — the UI flags that). */
  build: string | null;
  /**
   * The environment tag the LOG HEADER declared, uppercased — `"PUB"`, `"PTU"`,
   * `"TECH-PREVIEW"`, `"EPTU"` — or null when no header has been seen this session.
   *
   * 🔴 **THE LOG HEADER IS THE ONLY TRUTH HERE. Never derive this from `patch`.** That string is
   * the DATASET label: it currently reads `4.10.0-PTU.12479687` because the bundled 4.10 dataset
   * was built from a PTU extraction, and it would keep saying PTU on a genuinely LIVE 4.10 build
   * until someone builds a live dataset. Reading the environment off it would tell live players
   * their progress is not counting.
   */
  logEnv: string | null;
  /**
   * Whether receipts from the log being read count toward the real collection.
   *
   * 🔑 **null reads as LIVE, deliberately.** The app can attach mid-session and never see a
   * header, and refusing to track in that case would break the common install to protect the
   * rare one. So this is true for `null` and `"PUB"`, false for everything else — it mirrors
   * `isLiveEnv` exactly rather than re-deriving the rule, because two copies of a rule is how
   * they drift.
   */
  envIsLive: boolean;
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
  /** Contract facts (retake wait, run length, difficulty). null when the dataset has none. */
  facts: MissionFacts | null;
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
  /** Where you stand with the givers you have earned rep from — the idle panel’s standings
   *  segment. Best-progressed first; see standings(). */
  standings: FactionStanding[];
  /** Per-hour aUEC + rep rates for the idle screen. */
  earnings: EarningRates;
  /** The most-recently received blueprint (real-time receipts only), for the global
   *  "Blueprint Received" pop card — shown regardless of which mission is displayed, so a
   *  receipt is never missed when it lands on a same-named mission you aren't viewing.
   *  null until a blueprint is received live this session. `at` = the log receipt time. */
  justReceived: (BlueprintReward & { at: string }) | null;
  /**
   * Blueprints the log recorded that we could not place — the raw string the game wrote,
   * newest first — plus whether a modified language file is what is doing the renaming.
   *
   * 🔑 Shown rather than swallowed. An unmatched receipt is otherwise completely invisible:
   * the pool simply stays dark, which reads as "the app is broken" instead of "your language
   * file calls this something else". `packActive` is what decides whether offering Calibrate
   * would even make sense — there is nothing to recalibrate against on a stock install.
   */
  unrecognized: { names: string[]; packActive: boolean };
  /** Present for ~30s after a mission COMPLETES — the report card's data (payout, duration,
   *  blueprints received, plus the crowdsourcing context). null the rest of the time.
   *  An abandoned mission never sets this: there is no reward to summarise and nothing worth
   *  asking about a contract you walked away from. */
  completion: {
    title: string | null;
    /** aUEC awarded (live "Awarded N aUEC"), or null if none correlated. */
    aUEC: number | null;
    /** The mission's static dataset payout (FixedReward) — shown on the card when no live
     *  award was logged (current patches stopped emitting "Awarded N aUEC"). null if none.
     *  ⚠️ May be MODELLED — always read `payoutEstimated` beside it. */
    payout: { min: number | null; max: number; currency: string | null } | null;
    /** True when `payout` came from the fitted curve rather than the game files. The report
     *  card MUST mark it: the model is wrong about one time in four, and a completion card
     *  saying a flat number is read as "this is what you were just paid". */
    payoutEstimated: boolean;
    /** Contract facts — the card uses `cd` for "you can take this again in N". */
    facts: MissionFacts | null;
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

// 🔴 The Return of XenoThreat ladder USED TO BE HARDCODED HERE, with a detector that returned
// true for `generator === "TheBackpocket"`. That generator is shared: CIG uses it for BOTH
// XenoThreat (5 `RoX_` contracts) and 4.10's Orison Relief (13 `ORS_`), so **10 of the 13 Orison
// Relief contracts would have shown the XenoThreat reward ladder** and told the player to check
// "Journal → Return of XenoThreat". Both ladders now live in the hand-maintained
// `data/events.json` (see EventDef), matched on the CONTRACT-KEY PREFIX, which is the only thing
// that actually separates two events sharing a generator.

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
  /** Dynamic-event `log` name -> the completions witnessed as counting toward it. Persisted for
   *  the same reason repWitnessed is: each contribution is a one-time observation of something
   *  the game never restates, so losing it loses the estimate permanently. Absent in older state
   *  files, which reads correctly as "no event progress seen yet". */
  eventContributions?: Record<string, EventContribution[]>;
  rewardPrompts?: RewardPrompt[];
  askedTiers?: Record<string, number[]>;
}

/** Stored completed-mission record (newest first, capped). Deduped by missionId+at. */
interface MissionHistoryEntry {
  missionId: string | null;
  title: string | null;
  aUEC: number | null;
  at: string;
}

/**
 * Collapse the several log signals one completion emits into one history entry.
 *
 * Shared by the on-disk repair and expressed by the same rule the insert-side dedupe uses: two
 * entries are the same completion when they are close in time AND agree on mission id — or, where
 * one signal carries no id, on title. Never on the window alone: two DIFFERENT contracts can
 * genuinely finish in the same millisecond, and merging those would lose a completion.
 *
 * 🔑 The SURVIVOR is the richer entry, not the earlier one. The `end` signals carry no title and
 * the `contractComplete` does, so keeping whichever arrived first would strip half the history of
 * its names.
 */
function dedupeHistory(rows: MissionHistoryEntry[]): MissionHistoryEntry[] {
  const out: MissionHistoryEntry[] = [];
  for (const r of [...rows].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t)) continue;
    const hit = out.find((o) => {
      const dt = Math.abs(Date.parse(o.at) - t);
      if (!Number.isFinite(dt) || dt > COMPLETION_SIGNAL_MS) return false;
      if (r.missionId && o.missionId) return o.missionId === r.missionId;
      return !!r.title && o.title === r.title;
    });
    if (!hit) { out.push({ ...r }); continue; }
    if (r.title && !hit.title) hit.title = r.title;
    if (r.missionId && !hit.missionId) hit.missionId = r.missionId;
    if (r.aUEC != null && hit.aUEC == null) hit.aUEC = r.aUEC;
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)); // newest first, as stored
}

/** One number for what a contract pays, from the dataset's `{min, max, currency}`.
 *
 *  ⚠️ `min` is often 0, which the dataset documents as "up to max" rather than a real floor — so a
 *  midpoint of (0 + max) / 2 would halve every such payout. A positive min is a genuine range and
 *  gets the midpoint; anything else falls back to `max`.
 *
 *  ⚠️ Currency is UEC or **MER (prison merits)**. MER is not money and must never be summed into
 *  an aUEC total, so anything that is not UEC returns null. */
function payoutMid(p?: { min: number | null; max: number; currency: string | null } | null): number | null {
  if (!p || typeof p.max !== "number" || !(p.max > 0)) return null;
  if (p.currency && p.currency.toUpperCase() !== "UEC") return null;
  const min = typeof p.min === "number" && p.min > 0 ? p.min : null;
  return min !== null && min < p.max ? Math.round((min + p.max) / 2) : p.max;
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
/** The picker's "show me the idle screen" choice. NOT a mission id and never matches one — it is
 *  a third state beside a pinned mission and null (= auto-follow), which is why it needs a value
 *  of its own rather than being expressible as "no selection". */
export const IDLE_PICK = "__idle__";

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
/** How far apart two log signals may be and still describe the SAME completion.
 *
 *  The measured spread is 7ms (MissionEnded/EndMission at .795, the contractComplete notification
 *  at .802), so this is enormously generous — deliberately, because the cost of being too tight is
 *  a silently doubled scoreboard and the cost of being too loose is bounded by the id check that
 *  guards it. Nothing merges unless the mission ids agree, or one signal carries no id. */
const COMPLETION_SIGNAL_MS = 30_000;
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
/** Does this dataset record award any blueprint at all? 762 of 4,075 do. */
function hasAnyPool(m: DatasetMission): boolean {
  for (const entries of Object.values(m.pools ?? {})) if ((entries?.length ?? 0) > 0) return true;
  return false;
}

/** The INITIALS of each word: "Deep space hit" -> "dsh". The fuzzy band of mission search.
 *
 *  🔴 THIS REPLACED A PLAIN SUBSEQUENCE MATCH, WHICH MEASURED BADLY ENOUGH TO BE A MISFEATURE.
 *  "Are the needle's letters present in order, anywhere" sounds like fuzzy search and behaves like
 *  noise: searching `deep` returned "Deep space hit" and then filled six of eight slots with
 *  things like "Alliance Aid: Interstellar Medium Cargo Haul", where d-e-e-p simply occurs
 *  scattered across thirty characters. `dsh` returned nothing useful at all. A short query matches
 *  almost every long title, so the band drowned the very results it sat below.
 *  Initials are what people actually type for a remembered name, and they are precise: `dsh` finds
 *  "Deep space hit" and cannot claim "Alliance Aid...". Placeholders are stripped first so
 *  "Wanted: [TargetName]" contributes `w`, not `wt`. */
function initialsOf(hay: string): string {
  return hay
    .replace(/\[[^\]]*\]/g, " ")
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((w) => w[0])
    .join("")
    .toLowerCase();
}

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
  /** Dynamic-event definitions from the bundled data/events.json. See EventDef. */
  private events: EventDef[] = [];
  /** event `log` name -> the completions witnessed as counting toward it. Persisted: the
   *  estimate is an accumulation of things we saw once and can never re-observe, exactly like
   *  repWitnessed. */
  private eventContributions = new Map<string, EventContribution[]>();
  /** Tier-crossing questions awaiting an answer. See src/event-rewards.ts. */
  private rewardPrompts: RewardPrompt[] = [];
  /** Highest tier already asked about, per event id. Persisted, and it is what stops the app
   *  re-asking about every tier a returning player cleared weeks ago — `tiersCrossed()` cannot
   *  know that on its own, because a fresh session has no previous percentage to compare. */
  private askedTiers = new Map<string, number[]>();
  /**
   * Recent `Received Blueprint:` lines, for correlating a receipt with a tier crossing.
   *
   * 🔴 FILLED ABOVE THE `isLiveEnv` GATE, unlike `observed`. That gate exists because `observed`
   * is what SiteSync pushes with `replace: true`, so a PTU receipt reaching it would overwrite a
   * player's real collection. This buffer has no such path — it is in-memory, never persisted and
   * never synced — and an event runs on the PTU FIRST, which is exactly when these blanks need
   * filling. Gating it would have made the whole feature silently do nothing for Sub.
   */
  private recentReceipts: ReceiptNote[] = [];
  /**
   * Completions waiting to be claimed by the journal entry that follows them, OLDEST FIRST.
   *
   * 🔑 The journal line carries an ALL-ZEROS MissionId (measured: 4.10 PTU, 134 ms after the
   * completion), so time proximity is the only join available — the same correlation the aUEC
   * award already uses.
   *
   * 🔴 **A QUEUE, NOT A SINGLE SLOT — and real data is what proved it.** A single slot looked
   * correct until this ran against Sub's live 4.10 log, which contains two contracts completing
   * in the SAME MILLISECOND followed by two journal entries 115 ms apart:
   *   23:05:01.981  Contract Complete: Orison Relief: Small Supply Haul   [1c862f01…]
   *   23:05:01.981  Contract Complete: Orison Relief: Medium Supply Haul  [8ce13767…]
   *   23:05:02.116  Journal Entry Added: Orison Relief
   *   23:05:02.231  Journal Entry Added: Orison Relief
   * The slot held only the second completion, so BOTH entries were credited to the Medium haul —
   * 12,000 points from one 6,000 contract, with the Small haul's unknown value never recorded as
   * unpriced. FIFO matching also settles the open question in the parser's doc comment: the
   * journal fires **once per completion**, not once per batch (n is now 3, not 1).
   */
  private pendingEventCompletions: { key: string | null; title: string | null; missionId: string; atMs: number }[] = [];
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
  /** Title -> what that contract pays, or `null` when its variants disagree.
   *
   *  🔴 THE GAME STOPPED LOGGING PAYOUTS, so this is the only way the session scoreboard can show
   *  money at all. Measured on a real 15.5 MB session log (2026-08-21): `Awarded ` 0, `aUEC` 0,
   *  `UEC` 0, against 59 `Contract Complete` and 67 `Contract Accepted` in the same file — the
   *  control proves the search, and the award line is simply gone. What follows a completion now
   *  is "You've Earned: 12 Rewards / Access Them at Your Primary Residence's Inventory", which is
   *  ITEM loot and carries no currency.
   *
   *  Built exactly like `repTitleIndex` and for the same reason: a title can name several variants
   *  (540 of 1,273 do), so where they disagree this stores `null` and the caller shows nothing
   *  rather than picking one. Where they agree it keeps the SMALLEST figure — an earnings total
   *  that overstates is worse than one that undersells. */
  private payTitleIndex = new Map<string, { amount: number; modelled: boolean } | null>();
  private observed = new Set<string>();
  /** blueprint name -> earliest in-game unlock time (ISO-8601 UTC from the log). */
  private observedAt = new Map<string, string>();
  /** Turns a name the game wrote into the English name the dataset knows — for players on a
   *  non-English UI or running a language pack. See localization.ts. */
  private phrasebook!: Phrasebook;
  /** The log path the phrasebook was last built for, so a patch change can rebuild it against
   *  that patch's lang file without the server having to notice and re-push the path. */
  private phrasebookLogPath: string | null = null;
  /** Names that survived the phrasebook and STILL match nothing in the dataset, newest first.
   *  Surfaced rather than swallowed: an unmatched receipt is invisible otherwise, and this is
   *  the difference between "the app is broken" and "your language file renamed this". */
  private unrecognized = new Map<string, string>();
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
  /** normScreenTitle(title) -> debug_names of EVERY titled mission, pool-bearing or not. Read-only
   *  and used solely by mission search / previewByTitle; kept separate from `titleIndex` so a
   *  browsing feature can never influence which contract a live accept resolves to. */
  private allTitleIndex = new Map<string, string[]>();
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
    this.phrasebook = new Phrasebook(opts.dataDir);
    this.remoteBaseUrl = opts.remoteBaseUrl;
    this.stateDir =
      opts.stateDir ??
      join(process.env.APPDATA ?? process.env.HOME ?? ".", "sc-blueprint-tracker");
    this.statePath = join(this.stateDir, "collected.json");
    this.loadState();
    this.loadRepScopes();
    this.loadEvents();
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

  /** Load the hand-maintained dynamic-event registry. Same treatment as rep-scopes: loaded by
   *  FIXED name (changelist-independent — see EventDef) and entirely optional, so a bundle
   *  without it simply has no events rather than failing to start.
   *
   *  🔑 Read from `dataDir`, which is the WRITABLE user data dir seeded from the bundle. That is
   *  what lets a value be corrected during a live event without shipping a release — the whole
   *  point of the file (Sub: *"we'll update it like live in real time"*). `reloadEvents()` is
   *  exposed so a correction can be picked up without restarting the app. */
  private loadEvents(): void {
    try {
      const p = join(this.dataDir, "events.json");
      const d = JSON.parse(readFileSync(p, "utf8")) as { events?: EventDef[] };
      // Drop anything without the two fields every lookup depends on, rather than carrying a
      // half-declared event that silently matches nothing.
      this.events = (d.events ?? []).filter((e) => e && typeof e.log === "string" && e.log.trim() && typeof e.id === "string");
    } catch {
      this.events = [];
    }
  }

  /** Re-read `events.json` from disk. For the live-event workflow: a point value or reward is
   *  measured mid-session, the file is edited, and the track re-prices without a restart. */
  reloadEvents(): void {
    this.loadEvents();
    this.emit("change");
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

  /**
   * (Re)build the phrasebook for this install. Called when the configured log path is first
   * known and whenever it changes; `force` is what the Calibrate button passes, because a
   * player who just updated their language pack needs the file re-read even though its path
   * has not changed.
   *
   * 🔑 Takes the LOG path rather than a language file, because the log path is the one thing
   * we already know: `<channel>/game.log` puts the language file at
   * `<channel>/data/Localization/<g_language>/global.ini`.
   */
  setLogPath(logPath: string, force = false): PhrasebookInfo {
    this.phrasebookLogPath = logPath;
    const info = this.phrasebook.load(logPath, this.detectedChangelist, force);
    // Anything previously unresolvable deserves another go against the new table — otherwise
    // Calibrate would appear to do nothing for exactly the names it was pressed for.
    for (const [raw] of [...this.unrecognized]) {
      const english = this.phrasebook.translate(raw);
      if (english && this.itemUuidsForName(english).length) this.unrecognized.delete(raw);
    }
    this.emit("change");
    return info;
  }

  /** Phrasebook state plus the names that still match nothing, for diagnostics and the UI. */
  localizationStatus(): PhrasebookInfo & { unrecognized: { name: string; at: string }[] } {
    return {
      ...this.phrasebook.status(),
      unrecognized: [...this.unrecognized].map(([name, at]) => ({ name, at })).sort((a, b) => b.at.localeCompare(a.at)),
    };
  }

  /**
   * The English name for something the log called `raw`, plus whether we actually know it.
   *
   * Order matters: the phrasebook is consulted FIRST, but a name the dataset already knows is
   * never overridden — that keeps an English install byte-identical to its behaviour before
   * any of this existed, which is the whole safety argument for shipping it.
   */
  /**
   * The English mission title for a title as the log wrote it, or the title unchanged.
   *
   * ⚠️ Only STATIC titles can be recovered this way. A generated title is stored in the ini
   * with placeholders ("DEAD SAINTS - Trial Haul | ~mission(Location|name) > …") and the game
   * substitutes them before it writes the log, so the logged string never equals the ini
   * value and no lookup can match it. Those keep today's behaviour — which is fine, because
   * a generated title was never the identifier anyway (the contract marker is).
   */
  private englishTitle(title: string | null): string | null {
    if (!title) return title;
    if (this.titleIndex.has(normScreenTitle(title))) return title; // already ours
    return this.phrasebook.translate(title) ?? title;
  }

  private toEnglish(raw: string): { name: string; known: boolean } {
    if (this.itemUuidsForName(raw).length) return { name: raw, known: true };
    const english = this.phrasebook.translate(raw);
    if (english && this.itemUuidsForName(english).length) return { name: english, known: true };
    return { name: english ?? raw, known: false };
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
      // The phrasebook for this patch. Same best-effort treatment: without it a player on a
      // newly-fetched patch falls back to lang.latest.json, so anything the patch ADDED is
      // unresolvable for them — invisible, since their receipts still parse.
      await this.fetchIfMissing(`lang.${changelist}.json`);
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
        // The name -> item/image cache is keyed to THIS dataset. Detecting a new build mid-session
        // swaps it under us, and a stale uuid would show the wrong picture for a renamed item.
        this.rewardCache.clear();
        this.repPerContract.clear();
        // Follow the same changelist with the crafting-detail dataset (recipes/stats).
        this.detail.loadForChangelist(this.dataset.changelist);
        this.loadMissionFacts(this.dataset.changelist);
        this.buildTitleIndex();
        this.buildRepTitleIndex();
        // Follow the patch with the phrasebook too. Detecting a new build mid-session swaps the
        // dataset under us, and a phrasebook still keyed to the previous patch cannot name
        // anything the new one added — for a non-English player that reads as the new items
        // simply not existing.
        if (this.phrasebookLogPath) this.phrasebook.load(this.phrasebookLogPath, this.dataset.changelist);
        this.rankRewards.clear();   // keyed off dataset missions — a new dataset invalidates it
        this.reresolveAccepts();
        this.emit("change");
        return;
      } catch {
        /* try next */
      }
    }
  }

  /** Contract facts the main dataset does not carry — how long before you can take a mission
   *  again, how long it runs, CIG's blended difficulty, and whether failing locks you out.
   *
   *  🔑 A TRIMMED file (`tools/build-mission-facts.mjs`), not the site's `mission-extra`. That one
   *  is 6 MB and the app already ships a 4.5 MB dataset; the site reads it server-side and never
   *  sends it anywhere, so only the app pays for size. Trimmed to what the UI renders it is 0.38 MB.
   *  🔑 Absent file = every fact simply missing, which every renderer already handles — this must
   *  never be a hard dependency, because a dataset built before this existed has no such file. */
  private missionFacts: Record<string, MissionFacts> = {};
  private loadMissionFacts(changelist?: string): void {
    this.missionFacts = {};
    for (const p of [
      changelist ? join(this.dataDir, `mission-facts.${changelist}.json`) : null,
      join(this.dataDir, "mission-facts.latest.json"),
    ].filter(Boolean) as string[]) {
      if (!existsSync(p)) continue;
      try {
        const d = JSON.parse(readFileSync(p, "utf8")) as { missions?: Record<string, MissionFacts> };
        this.missionFacts = d.missions ?? {};
        return;
      } catch { /* try next */ }
    }
  }
  /** Facts for one contract key, or null. */
  factsFor(key: string | null | undefined): MissionFacts | null {
    return (key && this.missionFacts[key]) || null;
  }

  /** Facts common to EVERY variant of a title — a field survives only when they all agree.
   *  Used by the search brief, where a title can cover several contracts; the live panel and the
   *  completion card use `factsFor()` instead, because there the exact contract is known. */
  private mergeFacts(keys: string[]): MissionFacts | null {
    const all = keys.map((k) => this.missionFacts[k]).filter(Boolean) as MissionFacts[];
    if (!all.length) return null;
    const out: MissionFacts = {};
    for (const field of ["cd", "cdVar", "dur", "diff", "noRetry"] as const) {
      const first = all[0][field];
      if (first == null) continue;
      if (all.every((f) => f[field] === first)) (out as Record<string, unknown>)[field] = first;
    }
    return Object.keys(out).length ? out : null;
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
        const acceptTitle = this.englishTitle(ev.title);
        if (acceptTitle) info.title = acceptTitle;
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
          const doneTitle = this.englishTitle(ev.title);
          if (doneTitle && !info.title) info.title = doneTitle;
          this.missions.set(ev.missionId, info);
          this.beginCompletion(ev.missionId, doneTitle, ev.ts);
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
        // Correlation buffer FIRST, above the environment gate — see `recentReceipts`. A tier
        // reward that arrives on the PTU is still evidence of what that tier gives, and the
        // reason `observed` is gated does not apply to a buffer nothing syncs.
        this.noteReceiptForEvent(ev.name, ev.ts);
        // Dropped here rather than filtered later: `observed` is the authoritative set
        // SiteSync pushes with replace:true, so anything that reaches it is already live.
        if (!this.isLiveEnv) break;
        // Translate at the EDGE. `observed` is the authoritative set SiteSync pushes with
        // replace:true and the site renders from, so it must always speak English — a German
        // player's collection has to be the same collection as everyone else's. Everything
        // downstream (pools, images, /blueprints pages) is unchanged by this feature because
        // nothing downstream ever sees a localized string.
        const { name: bpName, known } = this.toEnglish(ev.name);
        if (!known) {
          // Record it and carry on. The receipt is still real — we simply cannot say what it
          // was, and saying so is the entire difference between a bug report and an answer.
          this.unrecognized.set(ev.name, ev.ts ?? new Date().toISOString());
        }
        const isNew = !this.observed.has(bpName);
        const dateChanged = this.noteReceiptTime(bpName, ev.ts);
        if (isNew) this.observed.add(bpName);
        // Global "Blueprint Received" pop card — REAL-TIME receipts only (not the historical
        // replay on startup), and independent of the displayed mission. Set before emitting so
        // the broadcast view carries the resolved image. Gated by COMPLETION_FRESH_MS like the
        // completion card so seeding the log at launch never pops a stale card.
        if (isNew) {
          const t = ev.ts ? Date.parse(ev.ts) : Date.now();
          if (!Number.isFinite(t) || Date.now() - t < COMPLETION_FRESH_MS) {
            this.justReceived = { ...this.blueprintReward(bpName), at: ev.ts ?? new Date().toISOString() };
          }
        }
        if (isNew || dateChanged) {
          this.saveState();
          if (isNew) this.emit("collected", bpName);
          this.emit("change");
        }
        break;
      }
      case "journalEntry": {
        // A dynamic event counted a completion. See MissionEvent["journalEntry"] for the
        // measurement this rests on and its n=1 caveat.
        if (ev.jurisdiction) break;               // entering a jurisdiction — not event progress
        /* 🔴 DELIBERATELY *NOT* GATED ON ENVIRONMENT — and it used to be, "same rule as
           blueprints". That reasoning does not survive contact with what the two things are.

           A blueprint receipt MUST be dropped on a test server because `observed` is the set
           SiteSync pushes with `replace: true`: anything reaching it overwrites the player's
           real collection on subliminal.gg. Event progress has no such path. `sync.ts` sends
           `got`, `mission` and `patch` and nothing else; no outbound request anywhere in the
           app carries a contribution. It is a local counter feeding a local widget.

           So the gate bought no safety and cost the entire feature exactly when it is most
           wanted: an event runs on the PTU FIRST, which is the whole reason to be there.
           Sub, 2026-08-22, 24,000 points into Siege of Orison on 4.10 PTU with the widget
           showing him nothing: "I need to be able to track these missions in the app."

           ⚠️ The player is still told where they are — `envIsLive` rides in the view and the
           PTU badge renders off it. Shown-and-labelled, not silently dropped. */
        const def = this.eventDefFor(ev.subject);
        if (!def) break;                          // an event we do not model; nothing to record
        const atMs = ev.ts ? Date.parse(ev.ts) : NaN;
        // 🔑 Correlate by TIME and CLAIM THE OLDEST pending completion. The journal line has an
        // all-zeros MissionId, so proximity is the only join — and because two contracts can
        // complete in the same millisecond and emit one journal entry each (measured on Sub's
        // 4.10 log), each entry must consume a DIFFERENT completion. FIFO is the right order:
        // the entries arrive in the order the completions did.
        // Window is the same REWARD_WINDOW_MS the aUEC award uses; the measured gap is 134 ms.
        const idx = Number.isFinite(atMs)
          ? this.pendingEventCompletions.findIndex((c) => Math.abs(atMs - c.atMs) <= REWARD_WINDOW_MS)
          : -1;
        // A contribution with no completion behind it is still recorded — it IS evidence the
        // event fired — but with a null key, so it counts as unpriced rather than being credited
        // to whatever finished minutes ago. Crediting it would invent points.
        const claimed = idx >= 0 ? this.pendingEventCompletions.splice(idx, 1)[0] : null;
        const key = claimed?.key ?? null;
        const points = key && def.contracts ? (def.contracts[key] ?? null) : null;
        const at = ev.ts ?? new Date().toISOString();
        const list = this.eventContributions.get(def.log) ?? [];
        // Dedupe on the log's own timestamp, which is stable across a re-seeded replay. Two
        // genuine entries 115 ms apart have different stamps, so this cannot collapse them.
        if (!list.some((c) => c.at === at)) {
          // Read the percentage BEFORE the contribution lands, so the crossing is a real
          // transition rather than a comparison against a number that already includes it.
          const before = this.eventProgress(def.id)?.pct ?? null;
          list.push({ key, title: claimed?.title ?? null, at, points });
          this.eventContributions.set(def.log, list);
          this.noteTierCrossings(def, before, Number.isFinite(atMs) ? atMs : Date.now(), at);
          this.saveState();
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
    // 🔑 Queue what just finished so a "Journal Entry Added: <event>" arriving in the next second
    // can claim it. Recorded for EVERY completion (carded or not, real-time or replayed) because
    // event progress is not gated on the card's freshness rule — a seeded log replay must credit
    // the same contributions a live session would.
    // ⚠️ Guarded on the SAME condition as completedAtByMission above: beginCompletion runs twice
    // per mission (contractComplete AND MissionEnded both call it), so an unguarded push would
    // queue every completion twice and let one journal entry claim a phantom.
    if (!this.completedAtByMission.has(missionId)) {
      this.completedAtByMission.set(missionId, completedAtMs);
      const info = this.missions.get(missionId);
      this.pendingEventCompletions.push({
        key: info?.contractKey ?? null,
        title: title ?? info?.title ?? null,
        missionId,
        atMs: completedAtMs,
      });
      // Bounded: only entries inside the correlation window can ever be claimed, so anything
      // older is dead weight. Trimmed here rather than on read so a long session cannot grow it.
      const floor = completedAtMs - REWARD_WINDOW_MS;
      this.pendingEventCompletions = this.pendingEventCompletions.filter((c) => c.atMs >= floor);
    }
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
      // 🔴 A MODELLED PAYOUT IS NOT AN EARNING. The fitted curve emits `min === max`, which is
      // byte-identical to the shape this test uses to recognise a real fixed reward — so every
      // one of the 2,045 estimates passed it and got recorded as money the player earned. That
      // history feeds the idle panel's "session earned" and aUEC/hr, so a scoreboard could
      // report a total that was substantially invented. Estimates are DISPLAYED (the report
      // card marks them) but never counted.
      const dm = this.datasetMission(missionId);
      const p = dm?.payout ?? null;
      const known = dm?.payoutCalculated !== true;
      const fixed = known && p && p.min != null && p.min === p.max && p.max > 0 ? p.max : null;
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
   *  payout by 20 seconds produces a rate nobody can actually sustain.
   *  🔴 A MODELLED payout is excluded for the same reason it is excluded from the history: it
   *  matches the `min === max` shape exactly, so without the flag every estimate became a
   *  derived "rate" one step further from anything anyone measured. */
  private completionRate(): number | null {
    const c = this.completion;
    if (!c || c.acceptedAtMs == null) return null;
    const ms = c.completedAtMs - c.acceptedAtMs;
    if (!(ms >= 60_000)) return null;
    const estimated = this.datasetMission(c.missionId)?.payoutCalculated === true;
    const p = estimated ? null : c.payout;
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
    // 🔴 ONE COMPLETION, SEVERAL LOG SIGNALS, MILLISECONDS APART — and an exact-timestamp dedupe
    // cannot see that, so every contract was recorded TWICE.
    //
    // Measured on a real session log (2026-08-21). Completing Combat Gauntlet Scenario #5 emitted:
    //   20:29:55.795  <MissionEnded> mission_state MISSION_STATE_COMPLETED   missionId 8ddc8dfb…
    //   20:29:55.795  <EndMission>   CompletionType[Complete]                missionId 8ddc8dfb…
    //   20:29:55.802  <SHUDEvent_OnNotification> "Contract Complete: …"      missionId 8ddc8dfb…
    // Same mission, same second, SEVEN MILLISECONDS apart — so `m.at === at` matched nothing and
    // the history grew two entries. `recentMissions` showed the pairs plainly once looked at
    // (…55.802 beside …55.795), and it inflated the session scoreboard's contract count and
    // reputation by ~2x for as long as both signals have been parsed.
    //
    // 🔑 The rep-crediting path already deduped by missionId and was therefore correct; only this
    // history did not. The file's own comment further down even records that "the log holds THREE
    // completion signals per mission" — the knowledge was here, this dedupe just didn't use it.
    //
    // ⚠️ Match on the ID, never on the window alone: two DIFFERENT contracts can genuinely
    // complete in the same millisecond (the event-track work measured exactly that and had to
    // stop a single-slot correlation from crediting both to one). So a shared window only merges
    // when the ids agree — or when one signal carries no id at all, where the title is all there
    // is to go on.
    const dupe = this.missionHistory.find((m) => {
      const dt = Math.abs(Date.parse(m.at) - parsed);
      if (!Number.isFinite(dt) || dt > COMPLETION_SIGNAL_MS) return false;
      if (missionId && m.missionId) return m.missionId === missionId;
      return !!title && m.title === title;
    });
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

  // 🔑 FOUR, not two — the view now carries more candidates than any one layout shows, because
  // the idle panel's shortlist is a RENDERING decision (how many fit, how they are ranked) and the
  // view model should not be the thing that caps it. The default layout still slices to two, so
  // nothing on screen changed by widening this.
  private closestPools(n = 4): ClosestPool[] {
    if (!this.dataset) return [];   // no dataset loaded yet — the idle panel just shows less
    // 🔴 Only what you can actually reach. Sub, 2026-08-13, in Pyro and being shown Nyx pools:
    // "I don't want to see anything for Nyx." A suggestion in another system is not a suggestion,
    // it is a chore you cannot start — and the panel exists to answer "what should I go do now".
    const here = this.playingIn();

    // ── Gather by POOL, not by contract ──────────────────────────────────────────────────────
    // The old loop pushed one row per CONTRACT and then tried to dedupe on title, which cannot
    // work: one pool is fed by up to 79 contracts across 5 different titles. Group on the pool's
    // own uuid and the repetition is gone by construction rather than by cleanup.
    type Acc = {
      entries: Map<string, PoolEntry>;    // keyed to collapse pure duplication — see below
      titles: Map<string, number>;        // title -> how many variants carry it
      variants: number;
      places: string[];
      givers: Set<string>;
      types: Set<string>;
      repKey: string; repTitle: string;   // the representative contract
      repRank: number;
    };
    const acc = new Map<string, Acc>();
    for (const [key, m] of Object.entries(this.dataset.missions)) {
      const reachable = !here || (() => {
        const sys = this.systemOf(m.places);
        // Unknown stays IN. 2,092 of 4,075 missions carry no place list at all, and dropping
        // every one of them would quietly hide most of the dataset to enforce a guess.
        return !sys || sys === here;
      })();
      if (!reachable) continue;
      for (const [uuid, list] of Object.entries(m.pools ?? {})) {
        if (!Array.isArray(list) || list.length < 2) continue;   // not a collection to finish
        let a = acc.get(uuid);
        if (!a) {
          a = { entries: new Map(), titles: new Map(), variants: 0, places: [], givers: new Set(),
                types: new Set(), repKey: key, repTitle: m.title, repRank: Infinity };
          acc.set(uuid, a);
        }
        a.variants++;
        a.titles.set(m.title, (a.titles.get(m.title) ?? 0) + 1);
        if (m.giver) a.givers.add(m.giver);
        if (m.missionType) a.types.add(m.missionType);
        for (const w of m.where ?? []) if (!a.places.includes(w)) a.places.push(w);
        // 🔴 DEDUPE ON THE ITEM UUID, NOT THE NAME. Three contracts list this refuelling pool's 8
        // blueprints TWICE — same names AND same item uuids — which would report "of 16" for a
        // pool of 8. But a repeated NAME is usually real: dataset-wide 165 mission-pool copies
        // repeat a name and 150 of those have all-distinct items (there are genuinely three
        // separate "Cinch Scraper Module" items). Keying on the item collapses only the true
        // duplication and leaves the counting semantics of everything else exactly as they were.
        // Entries with no item uuid fall back to a per-position key so they are never merged.
        list.forEach((e, i) => {
          a!.entries.set(e.item ?? `${key}#${i}`, e);
        });
        // The representative contract is the one with the SHORTEST title, tie-broken
        // alphabetically — deterministic, and the short title is reliably the least cluttered of
        // a pool's variants ("REFUEL REQUEST: [Ship]" over "CRITICAL REFUEL REQUEST: [Ship]").
        const rank = m.title.length;
        if (rank < a.repRank || (rank === a.repRank && m.title < a.repTitle)) {
          a.repRank = rank; a.repKey = key; a.repTitle = m.title;
        }
      }
    }

    // ── Score them ───────────────────────────────────────────────────────────────────────────
    const out: ClosestPool[] = [];
    for (const [uuid, a] of acc) {
      const entries = [...a.entries.values()];
      if (entries.length < 2) continue;
      let owned = 0;
      const missing = new Set<string>();
      for (const e of entries) {
        if (this.isOwned(e.blueprint).owned) owned++;
        else missing.add(e.blueprint);
      }
      if (owned === 0 || owned === entries.length) continue;   // untouched, or already done
      const m = this.dataset.missions[a.repKey];
      const f = this.factsFor(a.repKey);
      const repSum = (m?.reputationGained ?? []).reduce((s, r) => s + (r.amount || 0), 0);
      // 🔑 The friendly name is giver + type, which Sub asked for ("instead of it saying critical
      // fleet refuel it'll say Covalex refueling missions"). Stated ONLY when the pool's contracts
      // agree on both — 85 of 89 pools have one giver and 77 one type, and a pool spanning six
      // factions (there is one) must not be labelled with whichever we saw first. Otherwise the
      // representative title, which is at least true of something.
      // 🔑 TYPE FIRST, GIVER SECOND (Sub, 2026-08-15) — "Refueling · United Wayfarers Club". What
      // kind of work it is, is what you decide on; who is paying is the qualifier.
      const poolName = a.givers.size === 1 && a.types.size === 1
        ? `${[...a.types][0]} · ${[...a.givers][0]}`
        : a.repTitle;
      out.push({
        poolUuid: uuid,
        key: a.repKey,
        title: a.repTitle,
        poolName,
        // Shortest first, so the one the UI shows is the least cluttered.
        missionTitles: [...a.titles.keys()].sort((x, y) => x.length - y.length || x.localeCompare(y)),
        variants: a.variants,
        missing: [...missing].sort(),
        owned,
        total: entries.length,
        // Where to take it. `where` is the availability list the mission-info drawer uses; a
        // suggestion you cannot act on is just a statistic.
        places: a.places.slice(0, 3),
        payMin: m?.payout?.min ?? null,
        payMax: m?.payout?.max ?? null,
        payoutEstimated: m?.payoutCalculated === true,
        // 🔑 Guard the zero. `dur: 0` would divide into an infinite rate, and a contract that
        // takes no time is not a thing the panel should ever claim.
        durMin: f?.dur && f.dur > 0 ? f.dur : null,
        rep: repSum > 0 ? repSum : null,
        cooldownMin: f?.cd && f.cd > 0 ? f.cd : null,
        giver: a.givers.size === 1 ? [...a.givers][0] : null,
        missionType: a.types.size === 1 ? [...a.types][0] : null,
      });
    }
    out.sort((a, b) => (a.total - a.owned) - (b.total - b.owned)
      || b.owned / b.total - a.owned / a.total
      || a.poolName.localeCompare(b.poolName));
    // 🔑 TWO POOLS CAN SHARE A NAME AND THAT IS FINE HERE — the widget separates them on the line
    // below, with what you still need. Appending the missing blueprint to `poolName` was tried
    // first and MEASURED AS USELESS: "Shubin Interstellar · Ship Mining · BroadSpec" does not fit
    // a 380px row, so both rows ellipsised to the identical "Shubin Interstellar · Ship Mining…"
    // and the disambiguator was the part that got cut. A name is the wrong place to put the thing
    // that tells two names apart. `missing` is on the record and the renderer leads with it.
    const top = out.slice(0, n);

    // (The in-game TELL — a contract title only one of two same-named pools offers — was built
    //  here and removed 2026-08-15 when Sub cut it from the row. Worth keeping the measurement
    //  that came out of it: for the titles two same-named pools SHARE, they are byte-identical on
    //  rank, locations and payout, so there is genuinely nothing to tell a player to look for.
    //  The pool NAME is what gets you there instead — pick the category, then the giver.)
    return top;
  }

  /** name -> the reward record (item uuid + image URLs).
   *  🔑 MEMOISED, and it has to be. `itemUuidsForName()` rebuilds an entry list by walking every
   *  mission and every pool in the dataset on each call — fine for a receipt, which happens
   *  rarely, but this list resolves ten names on EVERY view frame and a frame goes out on every
   *  SSE tick. The dataset is immutable for the life of a load, so the answer cannot go stale;
   *  the cache is cleared wherever the dataset is swapped. */
  private rewardCache = new Map<string, BlueprintReward>();
  private blueprintRewardCached(name: string): BlueprintReward {
    let r = this.rewardCache.get(name);
    if (!r) { r = this.blueprintReward(name); this.rewardCache.set(name, r); }
    return r;
  }

  /** Median rep one contract from this giver awards — cached, since it walks the dataset.
   *  MEDIAN rather than mean: a giver's ladder spans easy and hard contracts and one 5,000-rep
   *  outlier would make the whole track look three contracts long. */
  private repPerContract = new Map<string, number>();
  private medianRepFor(giver: string): number | null {
    const key = norm(giver);
    const hit = this.repPerContract.get(key);
    if (hit !== undefined) return hit || null;
    const amounts: number[] = [];
    for (const m of Object.values(this.dataset?.missions ?? {})) {
      if (!m.giver || norm(m.giver) !== key) continue;
      const pr = this.primaryRep(m);
      if (pr && pr.amount > 0) amounts.push(pr.amount);
    }
    amounts.sort((a, b) => a - b);
    const med = amounts.length ? amounts[Math.floor(amounts.length / 2)] : 0;
    this.repPerContract.set(key, med);
    return med || null;
  }

  /** Where the player stands with every giver they have earned rep from, best-progressed first.
   *
   *  🔑 SORTED BY HOW FAR THROUGH THE CURRENT RANK THEY ARE, not by rep remaining. Measured on
   *  Sub's collection: sorting by absolute rep-to-go opens with Wikelo (320 rep) and three
   *  factions sitting at "Neutral" that he has barely touched — technically nearest, but reaching
   *  "Jr. Contractor" from nothing is not a milestone anyone is chasing. Sorting by PROGRESS
   *  surfaces Recco Battaglia at 72% of the way to Prestige 2, which is the one that actually
   *  feels close. The absolute cost rides along so the number is never flattering by omission. */
  private standings(n = 4): FactionStanding[] {
    const out: FactionStanding[] = [];
    for (const [faction, w] of this.repWitnessed) {
      const pos = repLadderPosition(this.repScopes[w.scope], w.sum);
      if (!pos) continue;
      const span = pos.nextMin != null ? pos.nextMin - pos.curMin : 0;
      const into = w.sum - pos.curMin;
      const toGo = pos.nextMin != null ? Math.max(0, pos.nextMin - w.sum) : null;
      const med = toGo != null ? this.medianRepFor(faction) : null;
      out.push({
        faction,
        scope: w.scope,
        standing: pos.standing,
        nextName: pos.nextName,
        estimate: w.sum,
        curMin: pos.curMin,
        nextMin: pos.nextMin,
        pct: span > 0 ? Math.max(0, Math.min(100, Math.round((into / span) * 100))) : 100,
        toGo,
        contractsToGo: toGo != null && med ? Math.max(1, Math.ceil(toGo / med)) : null,
        nextRewards: pos.nextRank == null ? [] : (this.rewardsByRank(faction).get(pos.nextRank) ?? []),
      });
    }
    // Max rank sinks: there is nothing to incentivise. Then most-progressed first.
    out.sort((a, b) => (a.toGo == null ? 1 : 0) - (b.toGo == null ? 1 : 0)
      || b.pct - a.pct
      || a.faction.localeCompare(b.faction));
    return out.slice(0, n);
  }

  private recentBlueprints(n = 10): RecentBlueprint[] {
    return [...this.observedAt.entries()]
      .filter(([, ts]) => Number.isFinite(Date.parse(ts)))
      .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
      .slice(0, n)
      .map(([name, at]) => {
        const r = this.blueprintRewardCached(name);
        return { name, at, item: r.item, image: r.image, imageFallback: r.imageFallback };
      });
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
    // IDLE_PICK is not a mission, so it deliberately skips the has() check that keeps a stale id
    // from being pinned. Everything else still has to name a mission the tracker knows about.
    this.selectedMissionId = missionId === IDLE_PICK
      ? IDLE_PICK
      : (missionId && this.missions.has(missionId) ? missionId : null);
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

  /**
   * What a contract KEY is worth, straight off the dataset — for callers holding a key and no
   * mission id, which is every hauling contract until it completes.
   *
   * 🔴 `payoutModelled` is why this returns a flag and not just a number. The dataset fills the
   * datacore's `reward="0"` rows from a fitted curve, and those are wrong about one time in four;
   * a caller that averages them into an aUEC/hour has fabricated a rate. Of the 853 `HaulCargo`
   * keys only 38 are modelled — but "nearly all read" is exactly the kind of thing that has to be
   * reported rather than assumed.
   *
   * Reputation carries no such caveat: it is read from the game files, and 839 of the 853 keys
   * have it.
   */
  rewardsForKey(contractKey: string): { payout: number | null; payoutModelled: boolean; rep: number } | null {
    const m = this.dataset?.missions[contractKey];
    if (!m) return null;
    return {
      payout: m.payout?.max ?? null,
      payoutModelled: m.payoutCalculated === true,
      rep: (m.reputationGained ?? []).reduce((s, r) => s + (r.amount || 0), 0),
    };
  }

  /** Every dataset mission whose KEY starts with `prefix`. For callers that reason about a whole
   *  family rather than one contract — the hauling advisor ranks all 853 `HaulCargo` keys. */
  missionsByKeyPrefix(prefix: string): Record<string, DatasetMission> {
    const out: Record<string, DatasetMission> = {};
    for (const [k, m] of Object.entries(this.dataset?.missions ?? {})) {
      if (k.startsWith(prefix)) out[k] = m;
    }
    return out;
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
    this.payTitleIndex.clear();
    if (!this.dataset) return;
    for (const m of Object.values(this.dataset.missions)) {
      const k0 = m.title ? normScreenTitle(m.title) : "";
      // Payout index. Built beside rep because it is the same walk and the same ambiguity rule;
      // note it does NOT require a giver, since event contracts pay money and no reputation.
      if (k0) {
        const amt = payoutMid(m.payout);
        if (amt !== null) {
          const entry = { amount: amt, modelled: m.payoutCalculated === true };
          if (!this.payTitleIndex.has(k0)) this.payTitleIndex.set(k0, entry);
          else {
            const cur = this.payTitleIndex.get(k0);
            if (cur != null) {
              // 🔑 Keep the smaller figure, and let "modelled" be sticky: if ANY variant behind
              // this title is a modelled guess, the answer is a guess. Understating and
              // over-marking are both the safe direction for a number the player reads as income.
              if (entry.amount < cur.amount) cur.amount = entry.amount;
              if (entry.modelled) cur.modelled = true;
            }
          }
        } else if (this.payTitleIndex.has(k0)) {
          // One variant pays and another does not: that is a disagreement, not a zero.
          this.payTitleIndex.set(k0, null);
        }
      }
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
    /**
     * 🔴 WHAT A COMPLETED CONTRACT WAS WORTH, now that the game no longer says.
     *
     * `m.aUEC` is the live "Awarded N aUEC" line, and current patches do not emit it — measured on
     * a real 15.5 MB session log: zero occurrences of `Awarded `/`aUEC`/`UEC` against 59
     * `Contract Complete` in the same file. So this figure was null for every completion and the
     * scoreboard showed "—" forever, which is what Sub reported.
     *
     * The fallback is the contract's own dataset payout, resolved the same way `repOf` resolves
     * reputation: by contract key when the completion has one, else by title through an index that
     * refuses to answer for titles whose variants disagree.
     *
     * 🔑 It returns the SOURCE alongside the number, because the two are not interchangeable. A
     * logged award is what the game paid you; a dataset payout is what the contract is listed as
     * paying, and roughly two thirds of the ones a player meets are MODELLED off a fitted curve
     * that is wrong about one time in four. The caller marks the total accordingly — an estimate
     * presented as a measurement is exactly the false precision this widget exists to avoid.
     */
    const payOf = (m: MissionHistoryEntry): { amount: number; modelled: boolean } | null => {
      if (m.aUEC != null) return { amount: m.aUEC, modelled: false }; // the game said so
      const ck = m.missionId ? this.missions.get(m.missionId)?.contractKey : undefined;
      const byKey = ck ? this.dataset?.missions[contractKeyOf(ck)] : undefined;
      if (byKey) {
        const amt = payoutMid(byKey.payout);
        if (amt !== null) return { amount: amt, modelled: byKey.payoutCalculated === true };
        return null; // we know exactly which contract this was, and it lists no payout
      }
      const e = m.title ? this.payTitleIndex.get(normScreenTitle(m.title)) : undefined;
      return e ?? null; // undefined = unknown title, null = its variants disagree; both mean "no"
    };
    const rows = this.missionHistory
      .map((m) => {
        const pay = payOf(m);
        return {
          atMs: Date.parse(m.at),
          aUEC: pay ? pay.amount : null,
          /** True when this row's figure is the contract's listed payout rather than a logged
           *  award. Today that is every row that has a figure at all. */
          estimated: pay ? m.aUEC == null : false,
          /** True when the listed payout is itself a modelled guess rather than read from the
           *  game files — a strictly weaker claim again, and the one worth warning about. */
          modelled: pay ? pay.modelled : false,
          rep: repOf(m),
        };
      })
      .filter((r) => Number.isFinite(r.atMs))
      .sort((a, b) => b.atMs - a.atMs); // newest first
    // Actual last rolling 60 minutes.
    const within = rows.filter((r) => now - r.atMs <= HOUR);
    const repLastHr = within.reduce((s, r) => s + r.rep, 0);
    const aUECknown = within.filter((r) => r.aUEC != null);
    const aUECLastHr = aUECknown.length ? aUECknown.reduce((s, r) => s + (r.aUEC ?? 0), 0) : null;
    // Current grind session = the most-recent contiguous run (break on a > SESSION_GAP_MS gap).
    const session: { atMs: number; aUEC: number | null; estimated: boolean; modelled: boolean; rep: number }[] = [];
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
    // 🔴 PROVENANCE TRAVELS WITH THE MONEY. `aUECEstimated` is true when any figure in the session
    // came from the contract's listed payout rather than a logged award, and `aUECModelled` when
    // any of those listed payouts is itself a fitted guess. The UI needs both: the first decides
    // whether to write "~", the second decides how strongly to caveat it.
    // 🔑 Counted over the SESSION rows, the same set `aUECTotal` is summed from — deriving it from
    // a different window would let the caveat disagree with the number it is captioning.
    const moneyRows = session.filter((r) => r.aUEC != null);
    const aUECEstimated = moneyRows.some((r) => r.estimated);
    const aUECModelled = moneyRows.some((r) => r.modelled);
    return {
      repLastHr: Math.round(repLastHr),
      repPace,
      aUECLastHr: aUECLastHr != null ? Math.round(aUECLastHr) : null,
      aUECPace,
      aUECTotal,
      aUECEstimated,
      aUECModelled,
      /** How many completions in this session contributed a money figure at all. The rest either
       *  list no payout or belong to a title whose variants disagree, and a total that silently
       *  covers 3 of 20 contracts would read as covering all 20. */
      aUECFrom: moneyRows.length,
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
    const witnessed = this.repWitnessed.get(giver);
    // 🔴 FALL BACK TO THE GIVER'S OWN TRACKED STANDING when this contract's reputation goes
    // somewhere we do not rank. Reported by Sub 2026-08-15: he accepted "Eliminate Annoyance" for
    // Headhunters and the standing bar vanished, though his Headhunters standing is real and
    // tracked (7,825 on FactionReputation). The contract awards rep ONLY on
    // `ShipCombat_HeadHunters`, which REP_SCOPE_DENY excludes, so primaryRep returned null and the
    // whole bar with it. Measured across the dataset: **384 of 4,075 contracts pay only denied
    // scopes**, and Headhunters is the worst-hit giver at 88 of them — so this was not an edge
    // case, it was most of a faction's board.
    // 🔑 The bar answers "where do I stand with these people", which is true regardless of which
    // internal track a particular contract happens to credit. What it must NOT do is imply this
    // contract will move it — see `offTrack`, which the panel says out loud.
    const scope = primary?.scope ?? witnessed?.scope;
    if (!scope) return null;
    const pos = repLadderPosition(this.repScopes[scope], witnessed?.sum ?? 0);
    if (!pos) return null;
    // True when the contract pays into a track that is not the one this bar measures, so
    // completing it will not advance what is shown. Both halves of that are worth saying.
    const offTrack = !primary || (!!witnessed && witnessed.scope !== scope);
    // What reaching the next rank actually hands over. Battaglia gates SHIPS this way and the
    // panel never mentioned them, so the bar was a number with no stated reason to care.
    const nextRewards = pos.nextRank == null ? [] : (this.rewardsByRank(giver).get(pos.nextRank) ?? []);
    return { scope, faction: giver, ...pos, nextRewards, offTrack };
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

  /**
   * The dynamic event a mission belongs to, or null.
   *
   * 🔴 **PREFIX FIRST, AND A GENERATOR MATCH NEVER DECIDES BETWEEN TWO EVENTS.** `TheBackpocket`
   * is shared by Orison Relief and Return of XenoThreat, so it can only ever answer "this is
   * some event mission" — never which. When the key is known the prefix decides outright; when
   * it is not, a generator match is accepted ONLY if exactly one declared event claims it, and
   * otherwise we decline rather than guess. Declining costs a ladder; guessing shows the wrong
   * event's rewards, which is what the old code did.
   */
  eventForMission(contractKey: string | null, generator: string | null): EventDef | null {
    if (contractKey) {
      const byPrefix = this.events.find((e) => (e.contractPrefixes ?? []).some((p) => contractKey.startsWith(p)));
      if (byPrefix) return byPrefix;
    }
    if (generator) {
      const claiming = this.events.filter((e) => (e.generators ?? []).includes(generator));
      if (claiming.length === 1) return claiming[0];
    }
    return null;
  }

  /** The event a journal-entry subject belongs to, or null. Exact match on the game's own
   *  string, case- and whitespace-insensitive only — deliberately NOT fuzzy, because a loose
   *  match here credits one event's progress to another. */
  private eventDefFor(subject: string): EventDef | null {
    const want = subject.trim().toLowerCase();
    return this.events.find((e) => e.log.trim().toLowerCase() === want) ?? null;
  }

  /** Every declared event, newest-relevant first (current → upcoming → past). */
  allEventProgress(): EventProgress[] {
    const rank = { current: 0, upcoming: 1, past: 2 } as const;
    return this.events
      .map((e) => this.eventProgress(e.id))
      .filter((t): t is EventProgress => !!t)
      .sort((a, b) => rank[a.status] - rank[b.status] || a.label.localeCompare(b.label));
  }

  /**
   * One event's track for the widget.
   *
   * 🔑 **The percentage is a LOWER BOUND, and the view says so in two separate ways.** The game
   * never tells the client the number (event points ride the same server-side
   * `ReputationService` as reputation), so this accumulates only what it witnessed — exactly the
   * policy the rep bar already uses. `unpriced` counts contributions whose contract value is not
   * yet in `events.json`; while it is non-zero the percentage is definitely an under-count and
   * the widget must not present it as a reading.
   */
  eventProgress(id: string): EventProgress | null {
    const def = this.events.find((e) => e.id === id);
    if (!def) return null;
    const contributions = this.eventContributions.get(def.log) ?? [];
    let points = 0;
    let unpriced = 0;
    for (const c of contributions) {
      // Re-price on every build rather than trusting the stored number: a value measured later
      // and added to events.json must retroactively fix contributions recorded before it was
      // known. That is the whole live-update workflow.
      const live = c.key && def.contracts ? def.contracts[c.key] : undefined;
      const p = live ?? c.points;
      if (typeof p === "number") points += p;
      else unpriced++;
    }
    const total = typeof def.total === "number" && def.total > 0 ? def.total : null;
    const pct = total ? Math.min(100, (points / total) * 100) : null;
    const rewards = def.rewards ?? [];
    const tiers = (def.tiers ?? []).slice().sort((a, b) => a - b).map((t) => {
      const rw = rewards.filter((r) => r.tier === t).map((r) => ({
        name: r.name,
        item: r.item ?? null,
        owned: this.isOwned(r.name).owned,
      }));
      return {
        pct: t,
        points: total ? Math.round((t / 100) * total) : null,
        // Only ever claim a tier is reached off a priced estimate. With `unpriced` outstanding
        // the estimate is low, so this under-claims — which is the correct direction to be wrong.
        reached: pct != null && pct >= t,
        rewards: rw,
      };
    });
    return {
      id: def.id,
      label: def.label,
      log: def.log,
      status: def.status ?? "current",
      total,
      points,
      pct,
      unpriced,
      contributions: contributions.slice().sort((a, b) => b.at.localeCompare(a.at)),
      tiers,
      rewardsUnknown: rewards.length === 0,
    };
  }

  // ── Self-filling event rewards (src/event-rewards.ts) ─────────────────────────────────────

  /** Remember a blueprint receipt just long enough to correlate it with a tier crossing.
   *  In memory only, capped, and never synced — see `recentReceipts`. */
  private noteReceiptForEvent(rawName: string, ts?: string | null): void {
    const atMs = ts ? Date.parse(ts) : Date.now();
    if (!Number.isFinite(atMs)) return;
    // Translate at the edge, exactly like `observed` does, so a German player's report names the
    // same blueprint everyone else's does. An unrecognised name is still recorded verbatim: the
    // whole point is to learn names we do not have.
    const { name } = this.toEnglish(rawName);
    this.recentReceipts.push({ name, atMs });
    // A crossing can only claim a receipt inside RECEIPT_WINDOW_MS, so anything older than a
    // generous multiple of that is dead weight.
    const floor = atMs - RECEIPT_WINDOW_MS * 10;
    this.recentReceipts = this.recentReceipts.filter((r) => r.atMs >= floor).slice(-40);
  }

  /**
   * Raise a question for each tier this contribution crossed.
   *
   * 🔑 THE RECEIPT IS NOT AVAILABLE YET, and that is not a bug. The journal entry is logged ~383
   * ms BEFORE the blueprint line, so at this moment `recentReceipts` cannot hold it. The prompt is
   * created now with `observed: null` and filled in by `resolvePrompts()` once the window closes —
   * which is also why `isPromptDue()` refuses to show a prompt until then. Raising the card
   * immediately would ask "we did not see what you got" and then change its mind a third of a
   * second later, which is worse than a card that arrives three seconds late.
   */
  private noteTierCrossings(def: EventDef, beforePct: number | null, crossedAtMs: number, crossedAt: string): void {
    const after = this.eventProgress(def.id)?.pct ?? null;
    const asked = this.askedTiers.get(def.id) ?? [];
    const measured = (def.rewards ?? []).map((r) => r.tier);
    for (const tier of tiersCrossed(beforePct, after, def.tiers ?? [])) {
      if (asked.includes(tier)) continue;
      // Record it as asked whatever happens next, so a tier whose reward is already known is
      // never revisited if that reward is later withdrawn from events.json.
      asked.push(tier);
      if (!shouldAsk(tier, measured)) continue;
      this.rewardPrompts.push({
        id: def.id + ":" + tier,
        eventId: def.id,
        eventLabel: def.label,
        tier,
        crossedAt,
        crossedAtMs,
        observed: null,
        candidate: candidateForTier(def.rewardCandidates, tier),
        answer: null,
        reported: false,
      });
    }
    this.askedTiers.set(def.id, asked);
    // Cap: a prompt is a question, and a backlog of them is a nag rather than a feature.
    if (this.rewardPrompts.length > 12) this.rewardPrompts = this.rewardPrompts.slice(-12);
  }

  /** Attach the observed blueprint to any prompt whose correlation window has now closed. */
  private resolvePrompts(nowMs: number): void {
    for (const p of this.rewardPrompts) {
      if (p.observed !== null || p.answer) continue;
      if (nowMs < p.crossedAtMs + RECEIPT_WINDOW_MS) continue;   // still collecting
      const hit = receiptForCrossing(p.crossedAtMs, this.recentReceipts);
      if (hit) p.observed = hit.name;
    }
  }

  /** The questions the UI should be showing right now. Never more than one — two cards stacked
   *  over a game is a modal by accident, and the second is still there when the first is answered. */
  eventRewardPrompts(nowMs = Date.now()): RewardPrompt[] {
    this.resolvePrompts(nowMs);
    const due = this.rewardPrompts.filter((p) => isPromptDue(p, nowMs));
    return due.slice(0, 1);
  }

  /**
   * Record the player's answer.
   *
   * 🔑 An empty name with source "typed" is NOT the same as "none": one is someone who started
   * typing and gave up, the other is someone asserting the tier gave them nothing. The caller
   * decides which it sent; this only stores it. `reportBody()` is what turns it into a claim.
   */
  answerRewardPrompt(id: string, name: string | null, source: PromptAnswerSource): RewardPrompt | null {
    const p = this.rewardPrompts.find((x) => x.id === id);
    if (!p || p.answer) return null;
    const clean = typeof name === "string" ? name.trim().slice(0, 120) : null;
    p.answer = { name: clean || null, source, at: new Date().toISOString() };
    this.saveState();
    this.emit("change");
    return p;
  }

  /** Prompts whose answers have not yet reached the site. Drained by the sidecar. */
  unreportedRewardAnswers(): RewardPrompt[] {
    return this.rewardPrompts.filter((p) => p.answer && !p.reported);
  }

  /** Mark an answer as delivered, so it is never sent twice. */
  markRewardAnswerReported(id: string): void {
    const p = this.rewardPrompts.find((x) => x.id === id);
    if (!p || p.reported) return;
    p.reported = true;
    this.saveState();
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
      payMax: m.payout?.max ?? null,
      payoutEstimated: m.payoutCalculated === true,
      // Guard the zero: a contract that takes no time would divide into an infinite rate.
      durMin: this.factsFor(key)?.dur && this.factsFor(key)!.dur! > 0 ? this.factsFor(key)!.dur! : null,
      diff: this.factsFor(key)?.diff ?? null,
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
    this.allTitleIndex.clear();
    if (!this.dataset) return;
    for (const [debugName, m] of Object.entries(this.dataset.missions)) {
      if (!m.title) continue;
      const k = normScreenTitle(m.title);
      if (!k) continue;
      // Every titled contract, pool or not — the search index (read-only, see allTitleIndex).
      const all = this.allTitleIndex.get(k);
      if (all) all.push(debugName);
      else this.allTitleIndex.set(k, [debugName]);
      // The TRACKING index keeps its original, narrower contract: pool-bearing only.
      if (Object.keys(m.pools ?? {}).length === 0) continue;
      const arr = this.titleIndex.get(k);
      if (arr) arr.push(debugName);
      else this.titleIndex.set(k, [debugName]);
    }
  }

  /** Do these same-titled contracts draw DIFFERENT blueprint pools? The one rule that decides
   *  whether a title can be shown as a single contract or has to be merged and labelled — shared
   *  by accept-resolution and by mission search so the two can never disagree about it. */
  private poolsDiffer(keys: string[]): boolean {
    const sig = (dn: string) => Object.keys(this.dataset?.missions[dn]?.pools ?? {}).sort().join(",");
    return new Set(keys.map(sig)).size > 1;
  }

  /** Every contract sharing a title, for the read-only mission brief.
   *  🔑 Deliberately NOT `resolveAcceptTitle`, which reads `titleIndex` — that index holds only
   *  pool-bearing missions because its job is resolving an accept to a POOL, so reusing it capped
   *  search at 762 of 4,075 contracts and 404'd on the biggest title in the game ("Trainee Rank -
   *  Small Cargo Haul", 253 variants). Widening `titleIndex` itself would have been the smaller
   *  diff and the wrong call: it feeds live accept resolution, and adding pool-less titles to it
   *  could change which mission a real accept resolves to. A search feature must not be able to
   *  move the tracker. The ambiguity RULE is shared via poolsDiffer(); only the index differs. */
  private variantsForTitle(title: string): { keys: string[]; ambiguous: boolean } | null {
    const k = normScreenTitle(title);
    if (!k || !this.dataset) return null;
    const keys = this.allTitleIndex.get(k);
    if (!keys?.length) return null;
    return { keys, ambiguous: this.poolsDiffer(keys) };
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
    return { keys, ambiguous: this.poolsDiffer(keys) };
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
    return !!this.eventForMission(info?.contractKey ?? null, info?.generator ?? null);
  }

  /** The mission whose pool to show: the manual pick if set; otherwise the newest
   *  accepted mission that has a pool (so a cargo haul accepted after a blueprint
   *  mission doesn't hide it); falling back to the newest of all. */
  private effectiveMissionId(): string | null {
    // 🔑 A THIRD PICKER STATE, because null already means AUTO. Sub, 2026-08-15: he wanted a way
    // back to the idle screen while missions are accepted, and "deselect" could not be expressed —
    // clearing the pick just handed the panel back to auto-follow, which immediately re-picked a
    // mission. The sentinel is checked FIRST and returns null, which is the one thing the whole
    // view already knows how to render.
    // 🔑 It STICKS, like a pinned mission does. An explicit choice that a later accept silently
    // undid would not be a choice; accepting something new while parked on idle is exactly when
    // you would be annoyed to be yanked away from the panel you asked for.
    if (this.selectedMissionId === IDLE_PICK) return null;
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
  searchMissionTitles(q: string, limit = 8): { title: string; key: string; variants: number; giver: string | null; hasPool: boolean }[] {
    const needle = q.trim().toLowerCase();
    const missions = this.dataset?.missions;
    if (!needle || !missions) return [];
    type Row = { title: string; key: string; variants: number; giver: string | null; hasPool: boolean };
    // Grouped by TITLE, because that is the unit a player searches for and the unit the brief is
    // built for. `variants` rides along so the result can say when a name covers more than one
    // contract rather than pretending it is one.
    // 🔑 GROUPED BY normScreenTitle, THE SAME KEY THE BRIEF MERGES ON — not by lowercase text.
    // The two normalisations disagree on punctuation, so grouping here by `toLowerCase()` while
    // previewByTitle() looks up by normScreenTitle() would let a row advertise "3 variants" and
    // then open a brief built from 4. A count on a control has to be the count the thing it opens
    // will actually show.
    const groups = new Map<string, Row>();
    for (const [key, m] of Object.entries(missions)) {
      const title = (m.title ?? "").trim();
      if (!title) continue;
      const norm = normScreenTitle(title);
      if (!norm) continue;
      const g = groups.get(norm);
      if (g) {
        g.variants++;
        g.hasPool = g.hasPool || hasAnyPool(m);
        continue;
      }
      groups.set(norm, { title, key, variants: 1, giver: m.giver ?? null, hasPool: hasAnyPool(m) });
    }
    const starts: Row[] = [], has: Row[] = [], fuzzy: Row[] = [];
    // The map key is now the NORMALISED title (upper-cased, punctuation stripped), so match
    // against the row's own display title instead — matching the normalised form would silently
    // stop finding anything the player types with an apostrophe or a colon.
    for (const row of groups.values()) {
      const l = row.title.toLowerCase();
      // 🔑 SEARCH THE PLACEHOLDER-STRIPPED TITLE TOO. 547 contracts are titled with a runtime
      // slot the game fills in — the player sees "Wanted: Vince Kroger" and the dataset says
      // "Wanted: [TargetName]" — so a raw substring match finds nothing for 13% of the catalogue,
      // which reads as the search being broken rather than as the data being templated. Matching
      // the stripped stem means typing the part that IS stable still finds it.
      const bare = l.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
      if (l.startsWith(needle) || bare.startsWith(needle)) starts.push(row);
      else if (l.includes(needle) || bare.includes(needle)) has.push(row);
      // Initials only earn a place for a query of 2+; a single letter would match a third of the
      // catalogue and say nothing about what the person meant.
      else if (needle.length >= 2 && initialsOf(l).startsWith(needle)) fuzzy.push(row);
    }
    // Prefix, then substring, then initials — strongest evidence of intent first. Ties inside a
    // band break on title so the list is stable between keystrokes instead of reshuffling.
    const byTitle = (a: Row, b: Row) => a.title.localeCompare(b.title);
    return [...starts.sort(byTitle), ...has.sort(byTitle), ...fuzzy.sort(byTitle)].slice(0, limit);
  }

  /** A read-only brief for a contract the player has NOT accepted — what the widget's mission
   *  search shows. Shaped like the fields of `view()` that `missionInfoHtml()` reads, so the
   *  search result renders through the SAME renderer as a live tracked mission and the two can
   *  never drift into looking like different features.
   *
   *  🔴 IT IS KEYED BY TITLE, AND A TITLE IS NOT A CONTRACT. 540 of the 1,273 distinct titles
   *  cover more than one variant — "Trainee Rank - Small Cargo Haul" is 253 separate contracts —
   *  and variants can draw DIFFERENT blueprint pools. Picking one and rendering it confidently is
   *  the bug that cost a player a week of grinding a pool that could never drop. So this reuses
   *  the tracker's own machinery rather than inventing a second answer: `resolveAcceptTitle`
   *  decides whether the variants genuinely differ (it compares pool signatures, not names), and
   *  when they do the pools are MERGED and `ambiguous` is set, which is exactly what the live
   *  panel already does and already labels.
   *
   *  🔑 Scalars are AGREE-OR-OMIT, which is the one place this deliberately does more than
   *  `view()`. A live ambiguous mission has no contractKey, so view() reads giver/type/payout off
   *  an undefined record and shows none of them — acceptable when you are mid-mission and the
   *  panel has other things to say, useless for a search result that would render nearly empty
   *  for 540 titles. Here each field is taken only when EVERY variant agrees on it, and dropped
   *  when they disagree. That cannot assert anything false, and in practice the variants differ
   *  in pool and location while agreeing on giver, type and price. */
  previewByTitle(title: string): MissionPreview | null {
    const res = this.variantsForTitle(title);
    if (!res || !res.keys.length || !this.dataset) return null;
    const { keys, ambiguous } = res;
    const records = keys.map((k) => this.dataset!.missions[k]).filter(Boolean) as DatasetMission[];
    if (!records.length) return null;

    // A field is only stated when every variant states the same thing. `pick` compares by a
    // stable serialisation so object-valued fields (payout, rep lists) collapse correctly.
    const pick = <T>(get: (m: DatasetMission) => T): T | null => {
      const first = get(records[0]);
      const sig = JSON.stringify(first ?? null);
      for (const m of records) if (JSON.stringify(get(m) ?? null) !== sig) return null;
      return first ?? null;
    };

    // 🔑 A KEY ONLY WHEN THERE IS EXACTLY ONE VARIANT — not merely when the pools happen to agree.
    // The key identifies a CONTRACT, and it is what the "More on the site" link and `otherPools`
    // are built from, so emitting keys[0] for a title covering 253 contracts points at a page
    // describing an arbitrary one of them. "Trainee Rank - Small Cargo Haul" is exactly that: all
    // 253 share an empty pool, so `ambiguous` is false and gating on it alone let one variant
    // speak for the rest.
    const single = keys.length === 1;
    const key = single ? keys[0] : null;
    const mission = single ? records[0] : undefined;
    const effectivePools = ambiguous ? this.mergePools(keys) : (records[0].pools ?? {});

    const pools: { poolUuid: string; blueprints: BlueprintStatus[] }[] = [];
    let owned = 0, total = 0;
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

    const giver = pick((m) => m.giver ?? null);
    const payout = pick((m) => m.payout ?? null);
    return {
      contractKey: key,
      title: pick((m) => m.title) ?? records[0].title ?? title,
      giver,
      missionType: pick((m) => m.missionType ?? null),
      illegal: pick((m) => m.illegal === true) === true,
      rankRequired: pick((m) => m.rank ?? null),
      rankRequiredName: this.rankName(records[0]),
      payout,
      payoutEstimated: pick((m) => m.payoutCalculated === true) === true,
      reputationGained: pick((m) => m.reputationGained ?? []) ?? [],
      reputationLost: pick((m) => m.reputationLost ?? []) ?? [],
      // Agree-or-omit, not just an `ambiguous` gate. The live panel drops places while ambiguous
      // because the candidates draw different pools — but variants can share a pool and still be
      // offered in completely different places, which is the 253-variant case, so "where do I pick
      // this up" has to be answered only when every variant answers it the same way.
      whereToGet: (ambiguous ? null : pick((m) => m.where ?? [])) ?? [],
      otherPools: this.otherPoolsFor(key, mission, ambiguous),
      inferredRank: giver ? this.inferredRank.get(giver) ?? null : null,
      // Giver-scoped, so it is meaningful whenever the variants agree on the giver — which is the
      // common case even when they differ in pool and place.
      repBar: giver ? this.computeRepBar(records[0]) : null,
      ambiguous,
      hasPool: total > 0,
      // 🔑 AGREE-OR-OMIT PER FIELD, not all-or-nothing on the title. Dropping every fact whenever
      // a title had siblings was too blunt and measurably wrong: the three "Cargo Hauling
      // Opportunity with Ling Hauling" variants share a 15-minute retake wait and differ only in
      // run length (27 / 41 / 65 min), so an all-or-nothing rule threw away a fact all three
      // agree on. Each field is kept when every variant states the same value.
      facts: this.mergeFacts(keys),
      variants: keys.length,
      pools,
      owned,
      total,
    };
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
    const evDef = pools.length === 0 ? this.eventForMission(key, tracked?.generator ?? null) : null;
    if (evDef) {
      // Group the flat reward list back into tiers. An event with no rewards recorded yet
      // (Orison Relief, until they are seen in game) yields NO tiers — so the panel says the
      // ladder is not known rather than drawing an empty one that reads as "no rewards".
      const byTier = new Map<number, { name: string; owned: boolean; source: BlueprintSource }[]>();
      for (const r of evDef.rewards ?? []) {
        const o = this.isOwned(r.name);
        const row = { name: r.name, owned: o.owned, source: o.source };
        const cur = byTier.get(r.tier);
        if (cur) cur.push(row);
        else byTier.set(r.tier, [row]);
      }
      eventTrack = {
        name: evDef.label,
        note: evDef.note ?? `Every ${evDef.label} mission you run adds to YOUR personal progress (not the server's). Check your in-game Journal for your current %.`,
        tiers: [...byTier.entries()].sort((a, b) => a[0] - b[0]).map(([pct, items]) => ({ pct, items })),
      };
    }

    return {
      patch: this.patch,
      build: this.detectedChangelist,
      // Read straight off the same two fields the gating uses, so the badge can never disagree
      // with whether blueprints are actually being recorded.
      logEnv: this.logEnv,
      envIsLive: this.isLiveEnv,
      contractKey: key,
      title: mission?.title ?? tracked?.title ?? null,
      generator: tracked?.generator ?? mission?.generatorClass ?? null,
      hasPool: pools.length > 0,
      ambiguous,
      payout: mission?.payout ?? null,
      payoutEstimated: mission?.payoutCalculated === true,
      facts: this.factsFor(key),
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
      standings: this.standings(),
      earnings: this.earningRates(),
      justReceived: this.justReceived,
      unrecognized: {
        // Capped: this is a nudge toward Calibrate, not a report. The full list is in
        // /api/diagnostics, which is where someone actually debugging will look.
        names: [...this.unrecognized].sort((a, b) => b[1].localeCompare(a[1])).slice(0, 5).map(([n]) => n),
        packActive: this.phrasebook.status().source === "ini",
      },
      completion: holdActive
        ? {
            title: this.completion!.title ?? mission?.title ?? tracked?.title ?? null,
            aUEC: this.completion!.aUEC,
            payout: this.completion!.payout,
            // `mission` in this scope IS the completed contract during the hold (see the note
            // below on effectiveId), so the flag comes from the same record the payout did.
            payoutEstimated: mission?.payoutCalculated === true,
            facts: this.factsFor(key),
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
      // 🔴 REPAIR THE DOUBLE-COUNTED HISTORY ALREADY ON DISK. The insert-side dedupe below only
      // stops NEW duplicates; every completion recorded before it existed was written twice (one
      // entry per log signal, milliseconds apart) and is restored here verbatim. Without this the
      // scoreboard stays wrong for every existing user forever, and the fix would look like it had
      // not worked — which is exactly how it presented while being diagnosed.
      this.missionHistory = dedupeHistory(data.missionHistory ?? []).slice(0, MISSION_HISTORY_MAX);
      this.eventContributions = new Map(Object.entries(data.eventContributions ?? {}));
      this.rewardPrompts = data.rewardPrompts ?? [];
      this.askedTiers = new Map(Object.entries(data.askedTiers ?? {}));
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
      eventContributions: Object.fromEntries(this.eventContributions),
      rewardPrompts: this.rewardPrompts,
      askedTiers: Object.fromEntries(this.askedTiers),
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
