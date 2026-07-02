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
export interface DatasetMission {
  title: string;
  generatorClass: string;
  missionKey: string;
  pools: Record<string, PoolEntry[]>;
  /** Static aUEC payout (schema/2). Most missions are runtime-calculated → null.
   *  min is often 0, meaning "up to max". Currency is UEC or MER (prison merits). */
  payout?: { min: number | null; max: number; currency: string | null } | null;
  /** ITEM rewards the mission hands out (schema/2) — actual items (Wikelo ships,
   *  armor, scrip), NOT blueprints. No ownership tracking; display-only. */
  items?: { name: string; item: string | null; amount: number }[] | null;
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
  itemRewards: { name: string; amount: number }[];
  /** True once the tracked mission has logged a COMPLETED end. */
  completed: boolean;
  pools: { poolUuid: string; blueprints: BlueprintStatus[] }[];
  totals: { owned: number; total: number };
  /** Lifetime collected count across all observed + overridden blueprints. */
  collectedTotal: number;
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
    /** Blueprint names received during the mission. */
    blueprints: string[];
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
    if (n === p || n.startsWith(p + " ") || p.startsWith(n + " ")) return true;
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

  private observed = new Set<string>();
  /** blueprint name -> earliest in-game unlock time (ISO-8601 UTC from the log). */
  private observedAt = new Map<string, string>();
  private overrides = new Map<string, boolean>();

  /** missionId -> info, built from accept + marker events. `acceptedAt` (log time,
   *  ms) powers the mission-duration readout on the completion card. */
  private missions = new Map<string, { title?: string; contractKey?: string; generator?: string; acceptedAt?: number }>();
  private trackedMissionId: string | null = null;
  /** missionIds in CreateMarker order, most recent last (deduped move-to-end). */
  private markerSeq: string[] = [];
  /** Manual override from the overlay picker; null = auto-follow. */
  private selectedMissionId: string | null = null;
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

  constructor(opts: MissionTrackerOptions) {
    super();
    this.dataDir = opts.dataDir;
    this.remoteBaseUrl = opts.remoteBaseUrl;
    this.stateDir =
      opts.stateDir ??
      join(process.env.APPDATA ?? process.env.HOME ?? ".", "sc-blueprint-tracker");
    this.statePath = join(this.stateDir, "collected.json");
    this.loadState();
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
        this.emit("change");
        return;
      } catch {
        /* try next */
      }
    }
  }

  /** Path to the bundled dataset whose version matches `family` ("4.8" → 4.8.2-…). */
  private datasetPathForFamily(family: string | null): string | null {
    if (!family) return null;
    try {
      for (const f of readdirSync(this.dataDir)) {
        if (!/^blueprints\.\d+\.json$/.test(f)) continue;
        const p = join(this.dataDir, f);
        try {
          const v = (JSON.parse(readFileSync(p, "utf8")) as Dataset).version;
          if (v && v.startsWith(family + ".")) return p;
        } catch {
          /* skip unreadable */
        }
      }
    } catch {
      /* no data dir */
    }
    return null;
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
        this.missions.set(ev.missionId, info);
        break;
      }
      case "marker": {
        const info = this.missions.get(ev.missionId) ?? {};
        info.contractKey = ev.contractKey;
        info.generator = ev.generator;
        this.missions.set(ev.missionId, info);
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
    if (Date.now() - completedAtMs > COMPLETION_FRESH_MS) return; // historical replay — no card
    if (this.completion && this.completion.missionId === missionId) {
      if (title && !this.completion.title) this.completion.title = title;
      return;
    }
    const info = this.missions.get(missionId);
    const aUEC =
      kind === "completed" && this.lastReward && Math.abs(this.lastReward.atMs - completedAtMs) <= REWARD_WINDOW_MS
        ? this.lastReward.amount
        : null;
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
    this.emit("change");
  }

  /** Blueprint names received during the completed mission (receipt time between its
   *  accept and completion) — the "+N blueprints" line on the completion card. */
  private completionBlueprints(): string[] {
    const c = this.completion;
    if (!c) return [];
    const lo = c.acceptedAtMs ?? -Infinity;
    const hi = c.completedAtMs + REWARD_WINDOW_MS;
    const out: string[] = [];
    for (const [name, ts] of this.observedAt) {
      const t = Date.parse(ts);
      if (Number.isFinite(t) && t >= lo && t <= hi) out.push(name);
    }
    return out;
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
      files++;
      for (const line of text.split(/\r?\n/)) {
        if (!line.includes("Received Blueprint:")) continue; // cheap prefilter
        const ev = parseMissionEvent(parseLine(line));
        if (ev && ev.kind === "blueprintReceived") {
          receipts++;
          const prev = receiptTimes.get(ev.name);
          // Keep the earliest parseable stamp; ensure the name is present even if the
          // stamp is missing (so it still counts toward observed).
          if (ev.ts && (prev == null || (prev !== undefined && Date.parse(ev.ts) < Date.parse(prev)))) {
            receiptTimes.set(ev.name, ev.ts);
          } else if (!receiptTimes.has(ev.name)) {
            receiptTimes.set(ev.name, ev.ts ?? null);
          }
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

  /** Clear the per-shard active-mission state (markers, ended/completed flags, the
   *  tracked/selected pointers). Keeps the collected blueprints — those are account-
   *  wide. Used on PU (re)entry and the manual "Refresh from log". */
  resetSession(): void {
    this.markerSeq = [];
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

  /** Dataset entry for a mission id, or undefined. Since schema/2 the missions map
   *  also holds pool-LESS missions that carry a payout or item rewards. */
  private datasetMission(missionId: string): DatasetMission | undefined {
    const key = this.missions.get(missionId)?.contractKey;
    return key ? this.dataset?.missions[key] : undefined;
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
    if (this.trackedMissionId && active(this.trackedMissionId) && this.missionHasContent(this.trackedMissionId)) {
      return this.trackedMissionId;
    }
    for (let i = this.markerSeq.length - 1; i >= 0; i--) {
      if (active(this.markerSeq[i]) && this.missionHasPool(this.markerSeq[i])) return this.markerSeq[i];
    }
    for (let i = this.markerSeq.length - 1; i >= 0; i--) {
      if (active(this.markerSeq[i])) return this.markerSeq[i];
    }
    // Nothing active — e.g. the LAST mission was just abandoned/completed. Show
    // nothing rather than the tracked-but-ended mission (which used to stick on
    // screen forever after abandoning your only mission).
    return this.trackedMissionId && active(this.trackedMissionId) ? this.trackedMissionId : null;
  }

  /** Active missions (ended ones excluded), newest first — for the overlay picker. */
  private knownMissions(): TrackedView["missions"] {
    return [...this.markerSeq].reverse().filter((id) => !this.endedMissionIds.has(id)).map((id) => {
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

    const pools: TrackedView["pools"] = [];
    let owned = 0;
    let total = 0;
    if (mission) {
      for (const [poolUuid, entries] of Object.entries(mission.pools ?? {})) {
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
      payout: mission?.payout ?? null,
      itemRewards: (mission?.items ?? []).map((i) => ({ name: i.name, amount: Number(i.amount) || 1 })),
      eventTrack,
      completed:
        (holdActive && this.completion!.kind === "completed") ||
        (effectiveId ? this.completedMissionIds.has(effectiveId) : false),
      pools,
      totals: { owned, total },
      collectedTotal: this.observed.size + [...this.overrides.values()].filter(Boolean).length,
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
    } catch {
      /* first run */
    }
  }

  private saveState(): void {
    const data: Persisted = {
      observed: [...this.observed],
      overrides: Object.fromEntries(this.overrides),
      observedAt: Object.fromEntries(this.observedAt),
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
