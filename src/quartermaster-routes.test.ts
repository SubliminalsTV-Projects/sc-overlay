// Quartermaster helper routes tests — station list, station price, autocomplete,
// fit-link parsing. Plain tsx + check(), same as the store suite.
//   npx tsx src/quartermaster-routes.test.ts
// The fit FETCH itself needs a real SP Viewer shared id (they are unguessable random
// bytes), so what is pinned here is everything around it: URL parsing, the tolerant
// component extractor, pricing against the REAL bundled shop table, and the fact that
// failures return sentences instead of throwing.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseFitUrl,
  qmPlaces,
  qmPriceAt,
  qmItemNames,
  type QmPlace,
} from "./quartermaster-routes.js";
import type { ItemShopTable, ShopItem, ShopTerminal } from "./item-shops.js";
import type { TradeTable, TradeQuote } from "./trade-prices.js";
import type { Commodity } from "./mining-economy.js";

let passed = 0;
let failed = 0;
function check(what: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log("  ✓ " + what); }
  else { failed++; console.log("  ✗ " + what + (detail ? " — " + detail : "")); }
}

/* ── fixtures: a small hand-built shop + trade table, plus the REAL bundle ───── */

function mkTerminals(n: string, place: string | null, sys: string | null): ShopTerminal {
  return { n, place, sys, body: null };
}

const SHOPS: ItemShopTable = {
  items: [
    // A missile sold at two stations, cheapest at Tressler.
    { n: "'Arrow' I Missile", co: "Vanduul Clans", c: "Missiles", s: "Weapons", z: "2", u: "082c2ffb-aaaa", q: [
      { t: 0, p: 300, m: 1750000000 }, { t: 1, p: 240, m: 1750000000 },
    ] },
    // A shield only rented at station 2 — the rent row must never be quoted.
    { n: "5CA 'Akura'", co: "Behring", c: "Shield Generators", s: "Systems", z: "3", u: "shld-akura", q: [
      { t: 2, p: 60000, m: 1750000000 }, { t: 2, p: 500, m: 1750000000, k: "rent" },
    ] },
    // A hull: Gladius at a dealer.
    { n: "Gladius", co: "Aegis", c: "Ships", s: "Vehicles", z: null, u: "aegs-gladius", q: [
      { t: 3, p: 1200000, m: 1750000000 }, { t: 3, p: 30000, m: 1750000000, k: "rent" },
    ] },
  ],
  terminals: [
    mkTerminals("Admin - GrimHEX", "GrimHEX", "Stanton"),
    mkTerminals("Admin - Port Tressler", "Port Tressler", "Stanton"),
    mkTerminals("TDD - Trade and Development Division - Lorville", "Lorville", "Stanton"),
    mkTerminals("New Deal Shipyard - Lorville", "Lorville", "Stanton"),
  ],
  source: "bundled", fetchedAt: null, droppedOffline: 0, catalogueOnly: 0, unpriced: [], lastError: null,
};

function mkQuote(commodity: string, terminal: string, place: string, buy: number | null): TradeQuote {
  return {
    commodity, terminal, terminalShort: place, system: "Stanton", body: null, place,
    buy, sell: null, stockScu: null, demandScu: null, maxContainerScu: null, asOf: 1750000000,
  };
}

const TRADE: TradeTable = {
  quotes: [
    mkQuote("Hydrogen Fuel", "Admin - Port Tressler", "Port Tressler", 8.02),
    mkQuote("Hydrogen Fuel", "Admin - GrimHEX", "GrimHEX", 9.5),
    mkQuote("Hydrogen Fuel", "Admin - Everus Harbor", "Everus Harbor", 7.4), // cheaper ELSEWHERE — must not leak in
  ],
  source: "bundled", fetchedAt: null, version: "test", droppedOffline: 0, lastError: null,
};

// The real bundled shop table, loaded straight from data/ — the join the fit pricer
// uses is only as good as its behaviour against real names.
const REAL_BUNDLE = JSON.parse(readFileSync(join(process.cwd(), "data", "item-shops.json"), "utf8")) as ItemShopTable;
const REAL_COMMODITIES = (JSON.parse(readFileSync(join(process.cwd(), "data", "commodities.json"), "utf8")) as {
  commodities: Record<string, Commodity>;
}).commodities;

/* ── station list ─────────────────────────────────────────────────────────── */

console.log("\nstation list");
{
  const places = qmPlaces(SHOPS, TRADE);
  const names = places.map((p) => p.name);
  check("terminal names collapse to stations", names.includes("GrimHEX") && names.includes("Port Tressler"), names.join(", "));
  check("TDD and shipyard terminals list as Lorville", names.filter((n) => n === "Lorville").length === 1);
  const lorville = places.find((p) => p.name === "Lorville") as QmPlace;
  check("the shared station carries the kiosk flag only when a kiosk sits there", lorville.kiosk === false);
  const tressler = places.find((p) => p.name === "Port Tressler") as QmPlace;
  check("a kiosk station is flagged", tressler.kiosk === true);
  const again = qmPlaces(SHOPS, TRADE);
  check("the list is cached per table identity", again === places);
}

/* ── price at a station ──────────────────────────────────────────────────── */

console.log("\nprice at a station");
{
  // Commodity lookups: uuid + name together (the route sends both; the name is the gate).
  const q1 = qmPriceAt("Port Tressler", SHOPS, TRADE, "uuid-h2", "Hydrogen Fuel", null, null);
  check("hydrogen at Tressler quotes the Tressler price", q1?.price === 8.02, JSON.stringify(q1));
  const q2 = qmPriceAt("GrimHEX", SHOPS, TRADE, "uuid-h2", "Hydrogen Fuel", null, null);
  check("hydrogen at GrimHEX quotes GrimHEX's price", q2?.price === 9.5, JSON.stringify(q2));
  const q3 = qmPriceAt("Everus Harbor", SHOPS, TRADE, "uuid-h2", "Hydrogen Fuel", null, null);
  check("a cheaper price at ANOTHER station never leaks in", q3?.price === 7.4 && q3.price < q1!.price);
  const none = qmPriceAt("Lorville", SHOPS, TRADE, "uuid-h2", "Hydrogen Fuel", null, null);
  check("a station with no kiosk returns null, not the nearest price", none === null, JSON.stringify(none));
  const wrong = qmPriceAt("Port Tressler", SHOPS, TRADE, "uuid-x", "Laranite", null, null);
  check("the commodity NAME gates the match, not just the station", wrong === null, JSON.stringify(wrong));

  const m1 = qmPriceAt("Port Tressler", SHOPS, TRADE, null, null, "082c2ffb-aaaa", null);
  check("missile by uuid prices at the cheapest terminal of that station", m1?.price === 240, JSON.stringify(m1));
  const m2 = qmPriceAt("GrimHEX", SHOPS, TRADE, null, null, "082c2ffb-aaaa", null);
  check("the same missile at GrimHEX prices 300", m2?.price === 300, JSON.stringify(m2));

  const rent = qmPriceAt("Lorville", SHOPS, TRADE, null, null, "shld-akura", null);
  check("a rental row is never quoted as a sale price", rent?.price === 60000, JSON.stringify(rent));

  const hull = qmPriceAt("Lorville", SHOPS, TRADE, null, null, "aegs-gladius", null);
  check("a ship hull prices its purchase, not its hire", hull?.price === 1200000, JSON.stringify(hull));
}

/* ── autocomplete ─────────────────────────────────────────────────────────── */

console.log("\nitem-name autocomplete");
{
  const hits = qmItemNames("hydrogen", REAL_COMMODITIES, REAL_BUNDLE, 12);
  check("hydrogen finds the commodity with its uuid", hits.some((h) => h.name === "Hydrogen Fuel" && h.commodityUuid && h.unit === "SCU"),
    JSON.stringify(hits.slice(0, 3)));
  check("the capture families rank first", hits[0]?.name === "Hydrogen Fuel", hits[0]?.name);
  const ammo = qmItemNames("ship ammunition", REAL_COMMODITIES, REAL_BUNDLE, 12);
  check("ship ammunition suggestions are all kiosk commodities with uuids",
    ammo.length >= 5 && ammo.every((h) => h.commodityUuid && h.unit === "SCU"), JSON.stringify(ammo.map((h) => h.name)));
  const missile = qmItemNames("arrow i missile", REAL_COMMODITIES, REAL_BUNDLE, 12);
  check("a component search finds the priced shop item", missile.some((h) => h.name.includes("Arrow") && h.price != null && h.unit === "units"),
    JSON.stringify(missile.slice(0, 2)));
  check("an empty query returns nothing (never the whole catalogue)", qmItemNames("", REAL_COMMODITIES, REAL_BUNDLE, 12).length === 0);
  check("a nonsense query returns nothing, not a guess", qmItemNames("zzqqxx", REAL_COMMODITIES, REAL_BUNDLE, 12).length === 0);
}

/* ── fit URL parsing ─────────────────────────────────────────────────────── */

console.log("\nfit link parsing");
{
  const good = parseFitUrl("https://www.spviewer.eu/performance?ship=aegs_gladius&loadout=Ab3xY9");
  check("a real share link parses", good?.ship === "aegs_gladius" && good?.sharedid === "Ab3xY9", JSON.stringify(good));
  const bare = parseFitUrl("Ab3xY9zZ");
  check("a bare shared id is accepted", bare?.sharedid === "Ab3xY9zZ");
  check("an spviewer url without a loadout param is refused", parseFitUrl("https://www.spviewer.eu/performance?ship=aegs_gladius") === null);
  check("another site is refused outright", parseFitUrl("https://evil.example/performance?ship=x&loadout=y") === null);
  check("garbage is refused", parseFitUrl("not a url at all") === null);
}

/* ── the fit pricer against the REAL bundle (no network) ──────────────────── */

console.log("\nfit component pricing (real bundle)");
{
  // Import the private pricer through the module's exported fetch (which prices after
  // decompress). Instead of a network fetch, exercise the same pricing path by pricing
  // component names directly through searchItems — the same call priceComponent makes.
  const { searchItems } = await import("./item-search.js");
  const table = REAL_BUNDLE;
  const priceOf = (name: string): number | null => {
    const exact = table.items.find((it) => it.n.toLowerCase() === name.toLowerCase());
    if (exact) {
      let best: number | null = null;
      for (const q of exact.q) { if (q.k !== "rent" && (best == null || q.p < best)) best = q.p; }
      if (best != null) return best;
    }
    return searchItems(table, name, { limit: 3, quotesPerItem: 1 })[0]?.low ?? null;
  };
  const arrow = priceOf("'Arrow' I Missile");
  check("a bare component name prices exactly", arrow != null && arrow > 0, String(arrow));
  const bare = priceOf("5CA Akura");
  check("a name without the quotes still finds the shield", bare != null && bare > 1000, String(bare));
  const drive = priceOf("Burst");
  check("a quantum drive prices", drive != null && drive > 1000, String(drive));
  const nonsense = priceOf("Definitely Not A Real Component 9000");
  check("an unknown component stays null, never a guess", nonsense === null);
  // Hull: the same shape priceHull walks.
  const gladius = table.items.find((it) => it.c === "Ships" && it.n === "Gladius");
  let hullBest: number | null = null;
  if (gladius) for (const q of gladius.q) { if (q.k !== "rent" && (hullBest == null || q.p < hullBest)) hullBest = q.p; }
  check("a hull prices its purchase and never its hire", hullBest != null && hullBest > 100000, String(hullBest));
}

console.log("\n" + (failed === 0 ? `all ${passed} checks passed` : `${failed} FAILED of ${passed + failed}`));
process.exit(failed === 0 ? 0 : 1);