/**
 * MINING / ECONOMY data access layer.
 *
 * Loads the two bundled, version-independent datasets the tracker ships for offline use:
 *   - commodities.json         (sc-commodities/1)       every tradeable material + refine
 *                                                        mapping + material props + per-
 *                                                        terminal BUY/SELL prices & stock
 *   - mining-composition.json  (sc-mining-composition/1) rock/deposit -> ore composition +
 *                                                        scan signature (a 4.8.0 baseline —
 *                                                        see the file's `sourceVersion`)
 *
 * Both are GLOBAL (game_commodities has no game_version_id; the resource tables only ever
 * imported for 4.8.0), so they load by FIXED name from the writable data dir (seeded from
 * the bundle by seedDataDir), like mineables.json / rep-scopes.json. Everything is
 * best-effort: a missing/old bundle simply yields empty lookups, never a throw.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** A per-terminal price quote for a commodity (aUEC/SCU); buy/sell/stock are null when the
 *  terminal doesn't offer that side. `location` is the starmap location UUID. */
export interface PriceQuote {
  terminal: string | null;
  location: string | null;
  buy: number | null;
  sell: number | null;
  stock: number | null;
}
export interface Commodity {
  name: string | null;
  key: string | null;
  kind: string | null;
  tier: string | null;
  /** What this ore/material refines into ({uuid,name}), or null. */
  refinesTo: { uuid: string; name: string | null } | null;
  /** Refinery-relevant material properties + density. */
  props: { instability: number | null; resistance: number | null; densityGPerCc: number | null };
  bestBuy: number | null;
  bestSell: number | null;
  prices: PriceQuote[];
}
/** One ore a rock/deposit can yield, with its yield-% range + drop probability. */
export interface CompositionOre {
  ore: string;
  oreUuid: string;
  minPct: number | null;
  maxPct: number | null;
  weight: number | null;
  probability: number | null;
}
export interface MiningResource {
  name: string | null;
  kind: string | null;
  tier: string | null;
  signature: number | null;
  composition: CompositionOre[];
}

interface CommoditiesFile {
  schema: string;
  version: string;
  commodityCount: number;
  commodities: Record<string, Commodity>;
}
interface CompositionFile {
  schema: string;
  sourceVersion: string;
  resourceCount: number;
  resources: Record<string, MiningResource>;
}

/**
 * Loads + serves the mining/economy datasets. Instantiated once by the server; the getters
 * are what the overlay/site read (directly or via /api/commodities & /api/mining-composition).
 */
export class MiningEconomyStore {
  private dataDir: string;
  private commoditiesFile: CommoditiesFile | null = null;
  private compositionFile: CompositionFile | null = null;
  /** commodity name (lowercased) -> uuid, for name lookups. */
  private commodityByName = new Map<string, string>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.load();
  }

  /** (Re)load both datasets from the data dir. Non-fatal on any error. */
  load(): void {
    this.commoditiesFile = this.read<CommoditiesFile>("commodities.json");
    this.compositionFile = this.read<CompositionFile>("mining-composition.json");
    this.commodityByName.clear();
    if (this.commoditiesFile) {
      for (const [uuid, c] of Object.entries(this.commoditiesFile.commodities)) {
        if (c.name) this.commodityByName.set(c.name.toLowerCase(), uuid);
      }
    }
  }

  private read<T>(file: string): T | null {
    try {
      const p = join(this.dataDir, file);
      if (!existsSync(p)) return null;
      return JSON.parse(readFileSync(p, "utf8")) as T;
    } catch {
      return null;
    }
  }

  /** How many rows each dataset loaded — for a startup health log. */
  counts(): { commodities: number; resources: number; compositionSource: string | null } {
    return {
      commodities: this.commoditiesFile?.commodityCount ?? 0,
      resources: this.compositionFile?.resourceCount ?? 0,
      compositionSource: this.compositionFile?.sourceVersion ?? null,
    };
  }

  /** A commodity by output item UUID or (case-insensitive) name; null when unknown. */
  commodity(uuidOrName: string): Commodity | null {
    if (!uuidOrName || !this.commoditiesFile) return null;
    const direct = this.commoditiesFile.commodities[uuidOrName];
    if (direct) return direct;
    const uuid = this.commodityByName.get(uuidOrName.toLowerCase());
    return uuid ? this.commoditiesFile.commodities[uuid] ?? null : null;
  }

  /** All commodities (map form) — the full economy dataset for a site/overlay view. */
  commodities(): Record<string, Commodity> {
    return this.commoditiesFile?.commodities ?? {};
  }

  /** Rock/deposit composition by its internal resource key; null when unknown. */
  composition(key: string): MiningResource | null {
    return this.compositionFile?.resources[key] ?? null;
  }

  /** All resources (map form) keyed by internal resource key. */
  resources(): Record<string, MiningResource> {
    return this.compositionFile?.resources ?? {};
  }
}
