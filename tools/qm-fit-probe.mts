/**
 * One-run probe: does a REAL SP Viewer fit link fetch, decompress and price end to end?
 *
 *   npx tsx tools/qm-fit-probe.mts "<https://www.spviewer.eu/performance?ship=aegs_gladius&loadout=XXXX>"
 *
 * Their shared ids are unguessable (8 random bytes), so the fetch could only ever be
 * verified against a link a human pressed Share on. This prints every stage — parse,
 * fetch, decompress, extracted components, priced/unpriced split, hull price — so the
 * fit parser's assumptions can be locked against the real payload shape before trusting
 * it in the widget. Unpriced component names are listed in full: they are exactly the
 * rows that tell us whether the tolerant extractor is finding the right strings.
 */
import { qmFetchFit, parseFitUrl } from "../src/quartermaster-routes.js";
import { ItemShopStore } from "../src/item-shops.js";
import { join } from "node:path";

const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
if (!arg) {
  console.error("usage: npx tsx tools/qm-fit-probe.mts \"<spviewer fit url>\" [--ptu]");
  process.exit(1);
}
const ptu = process.argv.includes("--ptu");

const parsed = parseFitUrl(arg);
console.log("parse:", parsed ? { ship: parsed.ship, sharedid: parsed.sharedid } : "REFUSED (not a fit link)");
if (!parsed) process.exit(1);

const store = new ItemShopStore({ dataDir: join(process.cwd(), "data"), stateDir: join(process.cwd(), "build"), url: null });
console.log("shop table:", store.current().items.length, "items,", store.current().terminals.length, "terminals,", store.current().source);

const result = await qmFetchFit(arg, store.current());
if (!result.ok) {
  console.error("fetch FAILED:", result.error);
  process.exit(1);
}
const f = result.fit;
console.log("\nship class:", f.ship, "| patch:", f.patch, "| build:", f.build);
console.log("hull price:", f.hullPrice != null ? f.hullPrice.toLocaleString() + " aUEC" : "unpriced");
console.log("components:", f.items.length, `(${f.unpricedCount} unpriced)`);
for (const i of f.items) {
  console.log("  " + i.name.padEnd(42) + (i.price != null ? i.price.toLocaleString().padStart(12) + " aUEC" : "  (unpriced)"));
}
console.log("\ntotal:", f.total.toLocaleString(), "aUEC");
if (ptu) console.log("(PTU mode noted; the shop table is the LIVE-side bundle unless refreshed)");
console.log(f.unpricedCount === 0 ? "\n✓ every component priced" : "\n⚠ unpriced names above — check them against the payload before trusting the extractor");