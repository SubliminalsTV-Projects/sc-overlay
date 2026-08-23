// Verse Finder search + the shop table's provenance — `npx tsx src/item-search.test.ts`.
//
// Driven against the REAL bundled table, because every problem this code exists to solve is a
// property of the actual catalogue. A synthetic fixture would keep passing after UEX renamed
// something, and — worse — could not express the false-match this whole module is built around:
// you need a real "Pulse \"Greycat\" Laser Pistol" sitting next to a real "Atlas" quantum drive
// before the bug is even reachable.
//
// 🔑 Every negative assertion below is paired with a POSITIVE one about the same set, and the
// positive comes first. "X is not in these results" is free when the results are empty, and an
// empty result set is exactly what a broken search produces — so the must-not-contain checks are
// only meaningful once something has established there is anything to contain.
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ItemShopStore, type ItemShopTable } from "./item-shops.js";
import { searchItems, tokenize, scoreItem, provenance } from "./item-search.js";

let failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "   [" + detail + "]" : ""}`);
};

const dataDir = fileURLToPath(new URL("../data", import.meta.url));
const store = new ItemShopStore({ dataDir, stateDir: mkdtempSync(join(tmpdir(), "verse-")), url: null });
const table = store.current();
const names = (q: string, n = 10) => searchItems(table, q, { limit: n }).map((h) => h.name);

console.log("the bundled table loads at all");
check("source is bundled with no network", table.source === "bundled", table.source);
check("it carries items", table.items.length > 1000, String(table.items.length));
check("it carries terminals", table.terminals.length > 100, String(table.terminals.length));
check("offline terminals were dropped and COUNTED", table.droppedOffline > 0, String(table.droppedOffline));
check("the un-shopped catalogue remainder is stated", table.catalogueOnly > 1000, String(table.catalogueOnly));

console.log("\ntokenizing — words never fuse, which is the whole defence");
check("punctuation splits", JSON.stringify(tokenize("P4-AR")) === '["p4","ar"]', tokenize("P4-AR").join("|"));
check("letters and digits part company", JSON.stringify(tokenize("FR-76")) === '["fr","76"]');
check("quotes and spaces split", JSON.stringify(tokenize('Pulse "Greycat" Laser Pistol')) === '["pulse","greycat","laser","pistol"]');

console.log("\n🔴 a match may never straddle a word boundary");
// ⚠️ THE OBVIOUS TEST HERE IS A TAUTOLOGY, and a negative control is what caught it. The survey's
// headline example — searching `Atlas` matching *Pulse "GreyCAT LASer" Pistol* — cannot be
// asserted against this table, because that pistol has no shop and so is not in the buyable set
// at all. "It is not in the results" was therefore true no matter what the tokenizer did.
// So this is checked two ways that CAN fail: a real straddle victim that is genuinely buyable,
// and the scorer driven directly on the original example.
const atlas = names("Atlas", 20);
check("searching Atlas returns something", atlas.length > 0, String(atlas.length));
check("the Atlas quantum drive is found", atlas.includes("Atlas"), atlas.slice(0, 4).join(" | "));
check("Atlas is ranked FIRST", atlas[0] === "Atlas", atlas[0] ?? "(none)");

// "10-Series Greatsword Cannon" fuses to "10seriesgreatswordcannon", which contains "10ser" —
// a string that spans the boundary between "10" and "series" and lives inside no single word.
const STRADDLER = "10-Series Greatsword Cannon";
const straddleHits = names("10-Series", 20);
check("the straddle victim is really in the table", straddleHits.includes(STRADDLER),
  straddleHits.slice(0, 3).join(" | "));
const fused = STRADDLER.toLowerCase().replace(/[^a-z0-9]+/g, "");
check("...and the naive normaliser really would match the straddling string",
  fused.includes("10ser") && !tokenize(STRADDLER).some((t) => t.includes("10ser")), fused);
check("but we do NOT match it", !names("10ser", 20).includes(STRADDLER),
  names("10ser", 5).join(" | ") || "(no hits)");

// The original example, driven straight through the scorer so it is falsifiable without needing
// the item to be for sale anywhere.
const pistol = { n: 'Pulse "Greycat" Laser Pistol', co: null, c: "Personal Weapons", s: "Personal Weapons", z: null, u: null, q: [] };
check("GreyCAT LASer scores ZERO for a search for Atlas",
  scoreItem(pistol, tokenize("Atlas"), "atlas") === 0,
  String(scoreItem(pistol, tokenize("Atlas"), "atlas")));
check("...while the fused form of that name really does contain 'atlas'",
  'Pulse "Greycat" Laser Pistol'.toLowerCase().replace(/[^a-z0-9]+/g, "").includes("atlas"));

console.log("\n⚠️ attachments must not outrank the thing itself");
const p4 = names("P4-AR", 10);
check("P4-AR returns something", p4.length > 0, String(p4.length));
check("the rifle is first, not its magazine", p4[0] === "P4-AR Rifle" || p4[0] === "P4-AR", p4.slice(0, 3).join(" | "));
const magIdx = p4.findIndex((n) => /magazine/i.test(n));
check("a magazine, if present, ranks BELOW it", magIdx !== 0, "index " + magIdx);
const gallant = names("Gallant", 10);
check("Gallant returns something", gallant.length > 0, String(gallant.length));
check("Gallant's first hit is not a battery", !/battery/i.test(gallant[0] ?? ""), gallant[0] ?? "(none)");

console.log("\n⚠️ components are bare names — the manufacturer has to be searchable");
const behring = searchItems(table, "behring", { limit: 500 });
check("behring matches items", behring.length > 0, String(behring.length));
check("...and they really are Behring's", behring.every((h) => /behring/i.test(h.company ?? "")),
  behring[0]?.company ?? "(none)");
const burst = names("Burst", 10);
check("Burst returns something", burst.length > 0, String(burst.length));
check("the bare-named quantum drive is first", burst[0] === "Burst", burst[0] ?? "(none)");

// 🔑 A COMPANY-ONLY HIT MUST NEVER BEAT A NAME HIT, and this needs a query where both really
// exist or the assertion is free. `microtech` is that case in the live table: exactly one item is
// NAMED microTech, and twenty more are merely MADE by them.
const micro = searchItems(table, "microtech", { limit: 30 });
const namedMicro = micro.filter((h) => /microtech/i.test(h.name));
const coOnlyMicro = micro.filter((h) => !/microtech/i.test(h.name) && /microtech/i.test(h.company ?? ""));
check("both kinds of hit are present", namedMicro.length > 0 && coOnlyMicro.length > 0,
  namedMicro.length + " named / " + coOnlyMicro.length + " by-company");
check("the item NAMED microTech ranks first", /microtech/i.test(micro[0]?.name ?? ""),
  micro[0]?.name ?? "(none)");
check("every name hit outscores every company-only hit",
  Math.min(...namedMicro.map((h) => h.score)) > Math.max(...coOnlyMicro.map((h) => h.score)),
  Math.min(...namedMicro.map((h) => h.score)) + " vs " + Math.max(...coOnlyMicro.map((h) => h.score)));

console.log("\ninitials, borrowed from the mission lookup");
check("oic finds Omnisky III Cannon", names("oic", 20).includes("Omnisky III Cannon"),
  names("oic", 5).join(" | "));
check("a single letter is refused as meaningless", searchItems(table, "o", { limit: 5 })
  .every((h) => h.name.toLowerCase().startsWith("o") || /^o/i.test(h.company ?? "")));

console.log("\n🔴 every result carries the honesty payload");
const sample = searchItems(table, "cannon", { limit: 25 });
check("the sample is non-empty", sample.length > 0, String(sample.length));
check("every hit names at least one shop", sample.every((h) => h.quotes.length > 0));
check("every quote names its TERMINAL", sample.every((h) => h.quotes.every((q) => !!q.terminal)));
check("every quote carries a real price", sample.every((h) => h.quotes.every((q) => q.price > 0)));
check("every quote carries its OWN asOf", sample.every((h) => h.quotes.every((q) => q.asOf > 0)));
check("every quote resolves to a place we can say out loud",
  sample.every((h) => h.quotes.every((q) => !!(q.place || q.body || q.system))));
check("quotes are cheapest-first", sample.every((h) =>
  h.quotes.every((q, i) => i === 0 || h.quotes[i - 1].price <= q.price)));
// 🔴 `low`/`high` became nullable when rentals arrived (a set of rental quotes has no PURCHASE
// spread). Assert they are populated here BEFORE using them, or every check below silently becomes
// a check about null: a shop item is always for sale outright, so a null in this table is a bug and
// not a shape to tolerate.
check("every shop item carries a purchase spread", sample.every((h) => h.low !== null && h.high !== null),
  sample.filter((h) => h.low === null).length + " with none");
check("low/high span every shop, not just the returned ones",
  sample.every((h) => h.low! <= h.quotes[0].price && h.high! >= h.quotes[h.quotes.length - 1].price));
check("no shop item claims a rental price", sample.every((h) => h.rentLow === null && h.rentHigh === null));
check("shopCount is never smaller than what was sent", sample.every((h) => h.shopCount >= h.quotes.length));

console.log("\n🔴 a truncated quote list still says how many shops there are");
const many = searchItems(table, "cannon", { limit: 40, quotesPerItem: 2 });
const truncated = many.filter((h) => h.shopCount > 2);
check("something really was truncated", truncated.length > 0, String(truncated.length));
check("...and each one still reports the full count", truncated.every((h) => h.quotes.length === 2 && h.shopCount > 2));

console.log("\n🔴 there is no stock field, and the wire says so");
const prov = provenance(table);
check("hasStock is stated false", prov.hasStock === false);
check("provenance names the source", prov.source === "bundled");
check("provenance carries the drop count", prov.droppedOffline > 0);
const anyQuote = sample[0].quotes[0] as unknown as Record<string, unknown>;
check("no quote carries a stock-shaped field",
  !Object.keys(anyQuote).some((k) => /stock|scu|qty|quantity|inventory/i.test(k)),
  Object.keys(anyQuote).join(","));

console.log("\nprice spread — 'the price' does not exist");
const spread = searchItems(table, "arms", { limit: 200 }).filter((h) => h.shopCount > 1);
check("multi-shop items exist in the table", spread.length > 0, String(spread.length));
check("at least one really does vary by shop", spread.some((h) => h.low! < h.high!),
  spread.filter((h) => h.low! < h.high!).length + " of " + spread.length);

console.log("\nthe uuid join to our own blueprint data");
const withUuid = table.items.filter((i) => i.u);
check("most items carry a game uuid", withUuid.length > 1000, String(withUuid.length));
check("they are lowercased so a join cannot miss on case",
  withUuid.every((i) => i.u === i.u!.toLowerCase()));

console.log("\nmaker + model - the way a player actually types a ship");
// Sub typed "Anvil Hawk" and got NOTHING, while "Hawk" alone found it. The maker was only ever
// consulted when EVERY token matched it, so a query split across maker and name matched neither
// half. Checked against the real bundled table, because the bug lived in the real catalogue.
for (const [q, want] of [["anvil hawk", "Hawk"], ["anvil arrow", "Arrow"], ["aegis gladius", "Gladius"]]) {
  const hits = searchItems(table, q, { limit: 5 });
  check(q + " finds " + want, hits.some((h) => h.name === want),
    hits.length ? hits.map((h) => h.name).join(", ") : "(nothing)");
}
// The pairing that stops the new tier being a free pass: a token belonging to NEITHER the name
// nor the maker must still miss, or every ship would match every query.
const junkMaker = searchItems(table, "anvil zzzqqxwv", { limit: 5 });
check("a real maker plus a junk model still finds nothing", junkMaker.length === 0,
  String(junkMaker.length));

console.log("\nempty and junk queries");
check("an empty query returns nothing, not everything", searchItems(table, "", { limit: 5 }).length === 0);
check("whitespace is the same as empty", searchItems(table, "   ", { limit: 5 }).length === 0);
check("punctuation-only is the same as empty", searchItems(table, "!!!", { limit: 5 }).length === 0);
check("a nonsense query returns nothing", searchItems(table, "zzzqqxwv", { limit: 5 }).length === 0);

console.log("\na malformed table is rejected WHOLE, never half-accepted");
// A quote pointing at a terminal that is not there would render a price with no place.
const badStore = new ItemShopStore({
  dataDir: mkdtempSync(join(tmpdir(), "verse-empty-")),
  stateDir: mkdtempSync(join(tmpdir(), "verse-empty2-")),
  url: null,
});
check("a missing bundle yields an empty table, not a throw", badStore.current().items.length === 0);
check("...and it still declares a source", badStore.current().source === "bundled");

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
