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
import { parseLine } from "./parser.js";

// ---- dataset shape (matches tools/build-blueprint-data.sql output) ----
export interface PoolEntry {
  blueprint: string;
  chance: number;
  item: string | null;
}
export interface DatasetMission {
  title: string;
  generatorClass: string;
  missionKey: string;
  pools: Record<string, PoolEntry[]>;
}
export interface Dataset {
  schema: string;
  version: string;
  changelist: string;
  missionCount: number;
  missions: Record<string, DatasetMission>;
}

// ---- overlay-facing view ----
export interface BlueprintStatus {
  name: string;
  owned: boolean;
  /** Why we think it's owned: an observed receipt, a manual override, or not owned. */
  source: "observed" | "override" | null;
  chance: number;
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
  /** True once the tracked mission has logged a COMPLETED end. */
  completed: boolean;
  pools: { poolUuid: string; blueprints: BlueprintStatus[] }[];
  totals: { owned: number; total: number };
  /** Lifetime collected count across all observed + overridden blueprints. */
  collectedTotal: number;
}

interface Persisted {
  observed: string[];
  overrides: Record<string, boolean>;
}

/** "Geist Armor Arms" matches an observed "Geist Armor Arms Whiteout" (variant suffix). */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}
function matchesPoolName(poolName: string, owned: Iterable<string>): boolean {
  const p = norm(poolName);
  for (const o of owned) {
    const n = norm(o);
    if (n === p || n.startsWith(p + " ") || p.startsWith(n + " ")) return true;
  }
  return false;
}

const CHANGELIST_RE = /build_version\[(\d+)\]|Changelist:\s*(\d+)/;
/** Pull the build changelist from a raw log line (header), or null. */
export function detectChangelist(rawLine: string): string | null {
  const m = rawLine.match(CHANGELIST_RE);
  return m ? (m[1] ?? m[2]) : null;
}

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
  private overrides = new Map<string, boolean>();

  /** missionId -> info, built from accept + marker events. */
  private missions = new Map<string, { title?: string; contractKey?: string; generator?: string }>();
  private trackedMissionId: string | null = null;
  private completedMissionIds = new Set<string>();

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
        this.missions.set(ev.missionId, info);
        break;
      }
      case "marker": {
        const info = this.missions.get(ev.missionId) ?? {};
        info.contractKey = ev.contractKey;
        info.generator = ev.generator;
        this.missions.set(ev.missionId, info);
        // The most recent objective marker = the mission being actively tracked.
        this.trackedMissionId = ev.missionId;
        this.emit("change");
        break;
      }
      case "end": {
        // Don't clear the view on completion — keep the last-tracked mission's pool
        // visible (so you see what just dropped) until a new mission is tracked.
        if (ev.missionId === this.trackedMissionId && ev.state.includes("COMPLETED")) {
          this.completedMissionIds.add(ev.missionId);
          this.emit("change");
        }
        break;
      }
      case "blueprintReceived": {
        if (!this.observed.has(ev.name)) {
          this.observed.add(ev.name);
          this.saveState();
          this.emit("collected", ev.name);
          this.emit("change");
        }
        break;
      }
      case "activeObjective":
        // Reserved for finer tracked-mission detection; markers already cover it.
        break;
    }
  }

  /** Re-scan a set of log files for `Received Blueprint` receipts and fold them into
   *  the collected set. Recovers history from rotated logbackups AND undoes accidental
   *  un-ticks (a not-owned override is cleared when the logs prove the blueprint was
   *  received). Read sequentially — backups can be tens of MB. */
  verifyFromLogs(paths: string[]): { files: number; receipts: number; added: number; restored: number } {
    const names = new Set<string>();
    let files = 0;
    let receipts = 0;
    for (const p of paths) {
      let text: string;
      try {
        text = readFileSync(p, "utf8");
      } catch {
        continue;
      }
      files++;
      for (const line of text.split(/\r?\n/)) {
        if (!line.includes("Received Blueprint:")) continue; // cheap prefilter
        const ev = parseMissionEvent(parseLine(line));
        if (ev && ev.kind === "blueprintReceived") {
          names.add(ev.name);
          receipts++;
        }
      }
    }
    let added = 0;
    for (const n of names) {
      if (!this.observed.has(n)) {
        this.observed.add(n);
        added++;
      }
    }
    // Clear any not-owned override the logs contradict — recovers accidental un-ticks.
    let restored = 0;
    for (const [name, val] of [...this.overrides]) {
      if (val === false && matchesPoolName(name, names)) {
        this.overrides.delete(name);
        restored++;
      }
    }
    this.saveState();
    this.emit("change");
    return { files, receipts, added, restored };
  }

  /** Manual owned/not-owned override (seeds pre-existing inventory the log can't see). */
  setOwned(blueprintName: string, owned: boolean): void {
    this.overrides.set(blueprintName, owned);
    this.saveState();
    this.emit("change");
  }

  // ---- ownership resolution ----

  private isOwned(poolName: string): { owned: boolean; source: "observed" | "override" | null } {
    // Explicit override on the exact pool name wins.
    if (this.overrides.has(poolName)) return { owned: this.overrides.get(poolName)!, source: "override" };
    // Otherwise any observed receipt that matches (incl. variant) counts.
    if (matchesPoolName(poolName, this.observed)) return { owned: true, source: "observed" };
    // Or an override on a variant name.
    for (const [name, val] of this.overrides) {
      if (val && matchesPoolName(poolName, [name])) return { owned: true, source: "override" };
    }
    return { owned: false, source: null };
  }

  // ---- subliminal.gg sync helpers ----
  // The site collection is keyed by output item UUID; the log only yields names,
  // so map names → UUIDs through the dataset (variant-aware, same as ownership).

  /** Item UUIDs whose blueprint name matches `received` in the current dataset. */
  itemUuidsForName(received: string): string[] {
    if (!this.dataset) return [];
    const out = new Set<string>();
    for (const mission of Object.values(this.dataset.missions)) {
      for (const entries of Object.values(mission.pools)) {
        for (const e of entries) {
          if (e.item && matchesPoolName(e.blueprint, [received])) out.add(e.item);
        }
      }
    }
    return [...out];
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
    const tracked = this.trackedMissionId ? this.missions.get(this.trackedMissionId) : undefined;
    const key = tracked?.contractKey ?? null;
    const mission = key && this.dataset ? this.dataset.missions[key] : undefined;

    const pools: TrackedView["pools"] = [];
    let owned = 0;
    let total = 0;
    if (mission) {
      for (const [poolUuid, entries] of Object.entries(mission.pools)) {
        const blueprints: BlueprintStatus[] = entries.map((e) => {
          const o = this.isOwned(e.blueprint);
          if (o.owned) owned++;
          total++;
          return { name: e.blueprint, owned: o.owned, source: o.source, chance: e.chance };
        });
        pools.push({ poolUuid, blueprints });
      }
    }

    return {
      patch: this.patch,
      build: this.detectedChangelist,
      contractKey: key,
      title: mission?.title ?? tracked?.title ?? null,
      generator: tracked?.generator ?? mission?.generatorClass ?? null,
      hasPool: !!mission,
      completed: this.trackedMissionId ? this.completedMissionIds.has(this.trackedMissionId) : false,
      pools,
      totals: { owned, total },
      collectedTotal: this.observed.size + [...this.overrides.values()].filter(Boolean).length,
    };
  }

  // ---- persistence ----

  private loadState(): void {
    try {
      const data = JSON.parse(readFileSync(this.statePath, "utf8")) as Persisted;
      this.observed = new Set(data.observed ?? []);
      this.overrides = new Map(Object.entries(data.overrides ?? {}));
    } catch {
      /* first run */
    }
  }

  private saveState(): void {
    const data: Persisted = {
      observed: [...this.observed],
      overrides: Object.fromEntries(this.overrides),
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
