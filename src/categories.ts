/**
 * Fabricator filter categories — mirrors Star Citizen's in-game item fabricator
 * filter (the 10 top-level tabs + text sub-categories). Icons are the game's own
 * `Inv_filter_Icons_*` glyphs, staged in `overlay/icons/cat-*.svg`.
 *
 * Shared by the overlay HUD and the subliminal.gg `/blueprints` page so both group
 * blueprints the same way the game does. Category labels are the exact strings from
 * game localization (`ui_inventory_filter_category_name_*` in global.ini).
 *
 * A blueprint is classified from its dataset `type` (always present) with
 * `classification`/`subType` refining the sub-category. `classification` alone is
 * unreliable — it's null for salvage/docking/cargo modules — so `type` leads.
 */

export type TabKey =
  | "armor" | "clothing" | "weapons" | "utility" | "ammo"
  | "vehicles" | "sustenance" | "container" | "other" | "missions";

export interface CategoryTab {
  key: TabKey;
  /** Game label (from localization). */
  label: string;
  /** Icon filename under overlay/icons/. */
  icon: string;
}

/** The 10 fabricator tabs, in the game's display order. Sub-categories are text-only
 *  (no icons) and are surfaced per-item via `categorize().sub`. */
export const CATEGORY_TABS: CategoryTab[] = [
  { key: "armor", label: "Armor", icon: "cat-armor.svg" },
  { key: "clothing", label: "Clothing", icon: "cat-clothing.svg" },
  { key: "weapons", label: "Weapons", icon: "cat-weapons.svg" },
  { key: "utility", label: "Utility", icon: "cat-utility.svg" },
  { key: "ammo", label: "Ammo", icon: "cat-ammo.svg" },
  { key: "vehicles", label: "Vehicles", icon: "cat-vehicles.svg" },
  { key: "sustenance", label: "Sustenance", icon: "cat-sustenance.svg" },
  { key: "container", label: "Container", icon: "cat-container.svg" },
  { key: "other", label: "Other", icon: "cat-other.svg" },
  { key: "missions", label: "Missions", icon: "cat-missions.svg" },
];

/** Minimal taxonomy an entry needs to be categorized (subset of dataset PoolEntry). */
export interface Categorizable {
  type?: string | null;
  subType?: string | null;
  classification?: string | null;
}

export interface Category {
  tab: TabKey;
  /** Sub-category label (text-only). */
  sub: string;
}

/** FPS personal-weapon size → sub-category (from FPS.Weapon.<size> or subType). */
function weaponSub(c: Categorizable): string {
  const size = (c.classification?.split(".")[2] || c.subType || "").toLowerCase();
  if (size.includes("small")) return "Sidearms";
  if (size.includes("medium")) return "Primary";
  if (size.includes("large") || size.includes("heavy")) return "Special"; // game's label for large weapons
  return "Weapons";
}

/**
 * Map a blueprint pool entry to its fabricator tab + sub-category. Keyed on `type`
 * (always present); every type in the current dataset is covered, with a keyword
 * fallback + `other` catch-all so a new type can never go missing.
 */
export function categorize(c: Categorizable): Category {
  const type = (c.type || "").trim();

  switch (type) {
    // ---- Armor (FPS armor slots; Undersuits fold in here per the game) ----
    case "Char_Armor_Helmet": return { tab: "armor", sub: "Helmets" };
    case "Char_Armor_Torso": return { tab: "armor", sub: "Core" };
    case "Char_Armor_Arms": return { tab: "armor", sub: "Arms" };
    case "Char_Armor_Legs": return { tab: "armor", sub: "Legs" };
    case "Char_Armor_Undersuit": return { tab: "armor", sub: "Undersuits" };
    case "Char_Armor_Backpack": return { tab: "armor", sub: "Backpacks" };

    // ---- Weapons (personal FPS weapons; size → sub) ----
    case "WeaponPersonal": return { tab: "weapons", sub: weaponSub(c) };

    // ---- Ammo (magazines) ----
    case "WeaponAttachment": return { tab: "ammo", sub: "Magazines" };

    // ---- Vehicles (all ship components live here) ----
    case "WeaponMining": return { tab: "vehicles", sub: "Mining" };
    case "WeaponGun": return { tab: "vehicles", sub: "Weapons" };
    case "Radar": return { tab: "vehicles", sub: "Radar" };
    case "Cooler": return { tab: "vehicles", sub: "Coolers" };
    case "PowerPlant": return { tab: "vehicles", sub: "Power Plants" };
    case "Shield": return { tab: "vehicles", sub: "Shields" };
    case "QuantumDrive": return { tab: "vehicles", sub: "Quantum Drives" };
    // Ship equipment with no matching Vehicles sub-category in-game → generic Other.
    case "SalvageModifier": return { tab: "vehicles", sub: "Other" };
    case "DockingCollar": return { tab: "vehicles", sub: "Other" };
    case "Cargo": return { tab: "vehicles", sub: "Other" };

    // ---- Other / unknown ----
    case "Misc": return { tab: "other", sub: "Misc" };
  }

  // Keyword fallback for any type not explicitly listed (keeps future data mapped).
  const t = type.toLowerCase();
  const cls = (c.classification || "").toLowerCase();
  if (cls.startsWith("fps.armor") || t.includes("armor")) return { tab: "armor", sub: "Other" };
  if (cls.startsWith("fps.weaponattachment") || t.includes("attachment")) return { tab: "ammo", sub: "Magazines" };
  if (cls.startsWith("fps.weapon") || t.includes("weaponpersonal")) return { tab: "weapons", sub: weaponSub(c) };
  if (cls.startsWith("ship") || t.startsWith("weapon") || ["radar", "cooler", "powerplant", "shield", "quantumdrive"].some((k) => t.includes(k)))
    return { tab: "vehicles", sub: "Other" };
  return { tab: "other", sub: "Misc" };
}
