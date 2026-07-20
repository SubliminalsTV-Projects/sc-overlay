/**
 * Per-blueprint CRAFTING DETAIL access layer.
 *
 * The main pool dataset (blueprints.<cl>.json) is what the tracker needs to run: which
 * mission drops which blueprint. This module loads the SEPARATE detail dataset
 * (blueprint-detail.<cl>.json, schema sc-blueprint-detail/4) that carries the crafting
 * recipe, dismantle returns, craft time, item stats, and manufacturer for each blueprint
 * — keyed by the blueprint's OUTPUT ITEM UUID, the same UUID the pool entries carry in
 * `PoolEntry.item` and the app's name→UUID index resolves to. So a resolved name → UUID
 * (via MissionTracker.itemUuidsForName) → detail lookup here.
 *
 * Loaded lazily and cached; it follows the SAME changelist the pool dataset resolved to
 * (exact build → latest bundled), so recipes match the pools on screen. The detail file
 * is bundled in data/ and seeded to %APPDATA% like the pool dataset (both are copied by
 * seedDataDir); the tracker never needs the DB.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** One ingredient/return line: a resource + quantity in SCU. */
export interface DetailMaterial {
  name: string;
  scu: number;
  /** Best per-SCU sell price (recipeGroups materials only), or null when UEX has no quote. */
  sell?: number | null;
}
/** A named recipe requirement slot as the fabricator kiosk shows it (CASING, LINER, …). */
export interface RecipeGroup {
  name: string;
  /** How many of the listed materials the slot requires. */
  requiredCount: number | null;
  /** True when the slot lists more materials than it requires (substitutable choices). */
  chooseOne: boolean;
  materials: DetailMaterial[];
}
/** A pre-formatted stat row (label + value + optional unit), as the kiosk renders it.
 *  Populated for armor (damage mitigation, temp/rad resistance, mass); other item types
 *  expose only Mass in the mirror, so their stats array is usually just that or empty. */
export interface DetailStat {
  label: string;
  value: string;
  unit: string | null;
}
/** Full crafting detail for one blueprint, keyed by its output item UUID. */
export interface BlueprintDetail {
  name: string;
  manufacturer: string | null;
  craftTimeSeconds: number | null;
  stats: DetailStat[];
  /** Flat ingredient list (resource + SCU), aggregated to the top crafting tier. */
  ingredients: DetailMaterial[];
  /** The recipe grouped into the kiosk's named requirement slots. */
  recipeGroups: RecipeGroup[];
  /** What you get back on dismantle (resource + SCU). */
  dismantle: DetailMaterial[];
}

/** The on-disk detail file (blueprint-detail.<cl>.json). `missions` carries per-mission
 *  reputation + reward; the app's main dataset already has those, so we only surface
 *  `blueprints` here. */
interface DetailFile {
  schema: string;
  version: string;
  changelist: string;
  blueprintCount: number;
  blueprints: Record<string, BlueprintDetail>;
  missionCount?: number;
  missions?: Record<string, unknown>;
}

/**
 * Loads + caches a detail dataset for a given changelist, mirroring the pool dataset's
 * file-selection (exact changelist → latest bundled). Read from the same writable data
 * dir the tracker uses. Absent/unreadable detail is non-fatal: `get()` just returns null
 * (older bundles that predate the detail file simply expose no recipes).
 */
export class BlueprintDetailStore {
  private dataDir: string;
  private file: DetailFile | null = null;
  private loadedFrom: string | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
  }

  /** The changelist of the currently-loaded detail file, or null. */
  get changelist(): string | null {
    return this.file?.changelist ?? null;
  }

  /** Load the detail file matching `changelist` (falling back to blueprint-detail.latest.json).
   *  A no-op if the same path is already loaded. */
  loadForChangelist(changelist?: string | null): void {
    const candidates = [
      changelist ? join(this.dataDir, `blueprint-detail.${changelist}.json`) : null,
      join(this.dataDir, "blueprint-detail.latest.json"),
    ].filter(Boolean) as string[];
    for (const p of candidates) {
      if (p === this.loadedFrom) return; // already have it
      if (!existsSync(p)) continue;
      try {
        const parsed = JSON.parse(readFileSync(p, "utf8")) as DetailFile;
        if (parsed && parsed.blueprints) {
          this.file = parsed;
          this.loadedFrom = p;
          return;
        }
      } catch {
        /* try next candidate */
      }
    }
    // Nothing loadable — leave whatever we had (or null on first run).
  }

  /** Detail for an output item UUID, or null when unknown / not loaded. */
  get(itemUuid: string | null | undefined): BlueprintDetail | null {
    if (!itemUuid || !this.file) return null;
    return this.file.blueprints[itemUuid] ?? this.file.blueprints[itemUuid.toLowerCase()] ?? null;
  }
}
