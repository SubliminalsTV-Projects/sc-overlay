/**
 * HAULING data access layer.
 *
 * Loads the three bundled, version-independent datasets the hauling optimiser needs:
 *   - ships.json           (sc-ships/1)           per-hull cargo grid geometry, in CELLS
 *   - hauling-orders.json  (sc-hauling-orders/1)  what a contract asks you to carry,
 *                                                 keyed by the contract key the log emits,
 *                                                 plus the canonical box-size table
 *   - locations.json       (sc-locations/1)       place names + the alias table that turns
 *                                                 a log code (`Stanton3_Area18`) into one
 *
 * All three are GLOBAL (not per-changelist), so they load by FIXED name from the writable
 * data dir seeded by seedDataDir — the same shape as MiningEconomyStore. Everything is
 * best-effort: a missing or old bundle yields empty lookups, never a throw.
 *
 * 🔑 EVERY DIMENSION IN HERE IS IN CELLS, not metres. One cell is 1.25 m and holds exactly
 * 1 SCU. Mixing the two units is the easiest way to get a packing bug that looks like a
 * rendering bug, so the raw metre values never leave the builders.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/** One cargo grid on a hull. `w`/`l`/`h` are cells; volume in cells IS the grid's SCU. */
export interface CargoGrid {
  /** Hardpoint name where the loadout named it, else the grid's class name. */
  port: string | null;
  /** Where this grid came from: the ship loadout, a name-prefix match, or upstream. */
  via: string;
  w: number;
  l: number;
  h: number;
  /** Largest box this grid accepts, in cells. ⚠️ Often ASYMMETRIC — a grid with
   *  `{x:2,y:8,z:2}` takes a 32 SCU box along Y only, never rotated. `null` = no cap. */
  maxBox: { x: number; y: number; z: number } | null;
}
export interface Ship {
  className: string;
  displayName: string | null;
  isSpaceship: boolean;
  totalScu: number;
  /** Which pipeline produced the geometry — see tools/build-ships.mjs. */
  source: string;
  /** Largest grid first. */
  grids: CargoGrid[];
}

/** One commodity line on a contract. Absent fields mean "the data does not say" — never
 *  zero. `maxContainerSize` absent means uncapped. */
export interface HaulingOrder {
  kind: string | null;
  resource?: string;
  commodity?: string | null;
  maxContainerSize?: number;
  minScu?: number;
  maxScu?: number;
  minAmount?: number;
  maxAmount?: number;
}
export interface HaulingContract {
  missionType: string | null;
  giver: string | null;
  orders: HaulingOrder[];
  source: string;
}
/** A cargo box size, with its footprint in cells. */
export interface BoxSize { scu: number; x: number; y: number; z: number }

export interface Location {
  name: string | null;
  slug: string | null;
  type: string | null;
  classification: string | null;
  parent: string | null;
  parentName: string | null;
  star: string | null;
  system: string | null;
  /** Internal code as the game log writes it, when the location carries one. */
  code: string | null;
  qtDestination: boolean | null;
  qt?: { arrival: number | null; obstruction: number | null };
}

interface ShipsFile { schema: string; version: string; shipCount: number; cellMetres: number; ships: Record<string, Ship> }
interface OrdersFile { schema: string; version: string; contractCount: number; boxes: Record<string, BoxSize>; contracts: Record<string, HaulingContract> }
interface LocationsFile { schema: string; source: string; locationCount: number; aliases: Record<string, string[]>; markerXyz: Record<string, string>; locations: Record<string, Location> }

/**
 * Loads + serves the hauling datasets. Instantiated once by the server; the getters are
 * what the widget reads (directly or via /api/ships, /api/hauling-orders, /api/locations).
 */
export class HaulingDataStore {
  private dataDir: string;
  private shipsFile: ShipsFile | null = null;
  private ordersFile: OrdersFile | null = null;
  private locationsFile: LocationsFile | null = null;
  /** lowercased display name -> ship class, for resolving a name the player picked. */
  private shipByName = new Map<string, string>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.load();
  }

  /** (Re)load all three datasets from the data dir. Non-fatal on any error. */
  load(): void {
    this.shipsFile = this.read<ShipsFile>("ships.json");
    this.ordersFile = this.read<OrdersFile>("hauling-orders.json");
    this.locationsFile = this.read<LocationsFile>("locations.json");
    this.shipByName.clear();
    for (const [cls, s] of Object.entries(this.shipsFile?.ships ?? {})) {
      // 🔑 First writer wins. Many hulls share a display name — "RSI Polaris" is also the
      // name of four AI variants — and the base class is emitted first, so keeping the
      // first match resolves a picked name to the flyable hull rather than a decoy.
      if (s.displayName && !this.shipByName.has(s.displayName.toLowerCase())) {
        this.shipByName.set(s.displayName.toLowerCase(), cls);
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
  counts(): { ships: number; contracts: number; locations: number; version: string | null } {
    return {
      ships: this.shipsFile?.shipCount ?? 0,
      contracts: this.ordersFile?.contractCount ?? 0,
      locations: this.locationsFile?.locationCount ?? 0,
      version: this.shipsFile?.version ?? null,
    };
  }

  /** A hull by class name or (case-insensitive) display name; null when unknown. */
  ship(classOrName: string): Ship | null {
    if (!classOrName || !this.shipsFile) return null;
    const direct = this.shipsFile.ships[classOrName];
    if (direct) return direct;
    const cls = this.shipByName.get(classOrName.toLowerCase());
    return cls ? this.shipsFile.ships[cls] ?? null : null;
  }

  /** All hulls (map form), keyed by class name. */
  ships(): Record<string, Ship> {
    return this.shipsFile?.ships ?? {};
  }

  /** Metres per cargo cell — 1.25. Grid and box dimensions are all in cells. */
  cellMetres(): number {
    return this.shipsFile?.cellMetres ?? 1.25;
  }

  /** A contract by the key the log's CreateMarker line emits; null when unknown. */
  contract(key: string): HaulingContract | null {
    return this.ordersFile?.contracts[key] ?? null;
  }

  /** All contracts (map form). */
  contracts(): Record<string, HaulingContract> {
    return this.ordersFile?.contracts ?? {};
  }

  /** Every cargo box size with its footprint in cells, keyed by SCU. */
  boxes(): Record<string, BoxSize> {
    return this.ordersFile?.boxes ?? {};
  }

  /**
   * The largest box a contract will hand you, across all its orders — the packer's key
   * input. `null` when the contract is unknown or declares no cap (uncapped means the
   * game may use any size, so the caller should assume the largest that fits).
   */
  maxBoxScu(key: string): number | null {
    const caps = this.contract(key)?.orders.map((o) => o.maxContainerSize).filter((n): n is number => !!n);
    return caps?.length ? Math.max(...caps) : null;
  }

  /** A location by UUID; null when unknown. */
  location(uuid: string): Location | null {
    return this.locationsFile?.locations[uuid] ?? null;
  }

  /** All locations (map form), keyed by UUID. */
  locations(): Record<string, Location> {
    return this.locationsFile?.locations ?? {};
  }

  /**
   * Resolve an internal code as written in game.log (`Stanton3_Area18`, `Lorville`) to
   * locations. Returns every match — codes are not unique, so a caller that needs one
   * should disambiguate by `type`.
   */
  byCode(code: string): Location[] {
    const uuids = this.locationsFile?.aliases[code?.toLowerCase()] ?? [];
    return uuids.map((u) => this.location(u)).filter((l): l is Location => !!l);
  }
}
