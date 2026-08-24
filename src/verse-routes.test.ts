/**
 * THE VERSE ROUTE, END TO END.  `npm run test:verseroutes`
 *
 * 🔴 WHY A WIRING TEST EARNS ITS KEEP HERE. `verse-proximity` and `origin-signals` are both
 * covered, and both were green while the widget still could not have shown a distance — because
 * being correct and being CONNECTED are different properties. This repo has the scar: a chat
 * feature is four layers and "the missing one fails SILENTLY", so a perfectly tested module
 * reached nothing. The same shape applies here, with an extra trapdoor: every part of the
 * proximity path is deliberately OPTIONAL and degrades to a coarser ordering, so a broken
 * connection does not throw — it quietly reports `basis: "none"` and looks like a player who
 * simply has not been anywhere yet.
 *
 * So this drives the REAL `verseRoutes` handler, through the REAL search and the REAL shipped
 * data, and asserts the distance actually arrives on the wire.
 *
 * 🔑 `url: ""` keeps it off the network — the bundled table is what a test should be pinned to
 * anyway, since a live refresh would make the assertions depend on what UEX said today.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { verseRoutes, type VerseDeps } from "./verse-routes.js";
import { matchKey, systemKey, type LocationRecord } from "./verse-proximity.js";

const DATA = join(process.cwd(), "data");
let pass = 0, fail = 0;
const ok = (c: boolean, name: string, detail = "") => {
  if (c) { pass++; console.log(`ok    ${name}${detail ? "  [" + detail + "]" : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  [" + detail + "]" : ""}`); }
};

const locations = (JSON.parse(readFileSync(join(DATA, "locations.json"), "utf8")) as
  { locations: Record<string, LocationRecord> }).locations;
const nameOf = (id: string) => locations[id]?.name ?? "?";

/** Minimal ServerResponse stand-in — the handler only ever writeHead()s and end()s JSON. */
function capture() {
  const out: { code?: number; body?: unknown } = {};
  const res = {
    writeHead(code: number) { out.code = code; return res; },
    end(body?: string) { out.body = body ? JSON.parse(body) : undefined; },
  };
  return { res: res as never, out };
}

const userDir = mkdtempSync(join(tmpdir(), "verse-routes-test-"));
const base: VerseDeps = { dataDir: DATA, userDir, url: "" };

const get = (path: string, deps: Partial<VerseDeps> = {}) => {
  const { res, out } = capture();
  const bare = path.split("?")[0];
  const handled = verseRoutes(bare, { url: path, method: "GET" }, res, { ...base, ...deps });
  return { handled, ...out } as { handled: boolean; code?: number; body: any };
};

// ── The bundle is actually loaded, or nothing below means anything ────────────────────────────
{
  const r = get("/api/verse/status");
  ok(r.handled && r.code === 200, "status answers 200", String(r.code));
  ok(r.body.itemCount > 1000, "...off a real table", `${r.body.itemCount} items`);
  ok(r.body.source === "bundled", "...from the bundled tier, with no network", r.body.source);
}

// ── With NO location signals: honest, and the order is left alone ─────────────────────────────
{
  const r = get("/api/verse/search?q=omnisky&shops=6");
  ok(r.body.results.length > 0, "a real query returns hits", `${r.body.results.length}`);
  ok(r.body.order?.basis === "none", "with no signals the basis is 'none'", r.body.order?.basis);
  ok(r.body.origin?.tier === "unknown", "...and the origin is unknown", r.body.origin?.tier);
  const prices = r.body.results[0].quotes.map((q: any) => q.price);
  ok(prices.every((p: number, i: number) => i === 0 || p >= prices[i - 1]),
     "...so the cheapest-first order stands", prices.join(","));
  ok(r.body.results[0].quotes.every((q: any) => q.minutes === null),
     "...and no row claims a distance");
}

// ── 🔴 WITH A FRESH FIX: the distance reaches the wire ────────────────────────────────────────
{
  const r = get("/api/verse/search?q=omnisky&shops=6", {
    locationSignals: () => ({
      atLocation: { token: "Area18", at: Date.now() - 60_000 },
      system: "stanton",
    }),
  });
  ok(r.body.origin?.tier === "place", "a fresh ASOP fix arrives as a PLACE origin", r.body.origin?.tier);
  ok(/Area18/i.test(r.body.origin?.label ?? ""), "...labelled with where we think you are",
     r.body.origin?.label);
  ok(r.body.order?.basis === "travel-time", "...and the order is by travel time", r.body.order?.basis);

  const q = r.body.results[0].quotes;
  ok(q.some((x: any) => x.minutes !== null), "...with real minutes on the wire",
     q.map((x: any) => x.minutes?.toFixed?.(1) ?? "null").join(", "));
  const mins = q.filter((x: any) => x.minutes !== null).map((x: any) => x.minutes);
  ok(mins.every((m: number, i: number) => i === 0 || m >= mins[i - 1]),
     "...ascending, nearest first", mins.map((m: number) => m.toFixed(1)).join(" <= "));

  // 🔑 THE TRUNCATION ASSERTION, and it is the reason `orderQuotes` is a hook inside searchItems
  // rather than something the route does to the returned array. This item sells at far more shops
  // than are returned, so if ordering happened AFTER the slice the nearest shop could not be in
  // the list at all unless it also happened to be among the cheapest.
  const hit = r.body.results[0];
  ok(hit.shopCount > hit.quotes.length,
     "the item really is truncated, so the ordering had to happen before the slice",
     `${hit.quotes.length} of ${hit.shopCount}`);

  // And the nearest returned shop must be at least as near as anything the price order would have
  // put first — i.e. ordering changed something.
  const byPrice = get("/api/verse/search?q=omnisky&shops=6").body.results[0].quotes;
  ok(JSON.stringify(byPrice.map((x: any) => x.terminal)) !==
     JSON.stringify(q.map((x: any) => x.terminal)),
     "...and the proximity order genuinely differs from the price order");

  // 🔴 THE ASSERTION THAT ACTUALLY CATCHES SLICE-THEN-ORDER. Re-sorting the cheapest six can only
  // ever permute that same six, so the returned SET would be identical to the price set and only
  // its order would move — which the check above would still pass. Ordering first draws from all
  // 18, so it must be able to return a shop the cheapest six do not contain.
  const priceSet = new Set(byPrice.map((x: any) => x.terminal));
  const pulledIn = q.filter((x: any) => !priceSet.has(x.terminal));
  ok(pulledIn.length > 0,
     "...and surfaced a near shop that is NOT among the cheapest six",
     pulledIn.map((x: any) => `${x.place}:${x.minutes?.toFixed(1)}m`).join(", ") || "none");
}

// ── A STALE fix degrades to containment, all the way to the wire ──────────────────────────────
{
  const r = get("/api/verse/search?q=omnisky&shops=6", {
    locationSignals: () => ({
      // Inside the 45-minute place window but past half of it, which is what `stale` means.
      atLocation: { token: "Area18", at: Date.now() - 30 * 60_000 },
      system: "stanton",
    }),
  });
  ok(r.body.origin?.stale === true, "a 30-minute-old fix is marked stale", String(r.body.origin?.stale));
  ok(r.body.order?.basis === "containment", "...and degrades to containment", r.body.order?.basis);
  ok(r.body.results[0].quotes.every((q: any) => q.minutes === null),
     "...stating no minutes anywhere");
  ok(r.body.results[0].quotes.some((q: any) => q.containment),
     "...but still saying how each shop relates to you",
     r.body.results[0].quotes.map((q: any) => q.containment).join(","));
}

// ── An empty query claims no basis at all ─────────────────────────────────────────────────────
{
  const r = get("/api/verse/search?q=", {
    locationSignals: () => ({ atLocation: { token: "Area18", at: Date.now() }, system: "stanton" }),
  });
  ok(r.body.results.length === 0, "an empty query returns nothing", `${r.body.results.length}`);
  ok(r.body.order === null,
     "...and claims NO ordering basis, because nothing was ordered", JSON.stringify(r.body.order));
}

// ── 🔴 SUB'S REPORT, 2026-08-23: THE CAP WAS DELETING EVERY OUT-OF-SYSTEM SHOP ────────────────
//
// *"The Verse Finder can only show me what is available in this system. Which of course things in
// the system should be at the top, but it shouldn't be excluded."*
//
// No filter was ever involved — `orderByProximity` ranks `elsewhere` last by design and the caller
// kept the first N, and those two correct behaviours composed into an exclusion. This is the wiring
// half of the fix: `reserveTierRows` is unit-tested in `test:proximity`, and what is asserted HERE
// is that its answer survives all the way onto the wire, through the search's own truncation.
//
// 🔑 MedPen is the real reported shape: 157 shops spanning all four containment tiers, so a cap of
// 5 lands entirely inside the two nearest ones. Counts are printed in every detail so the pairing
// is visible rather than taken on faith.
{
  const signals = () => ({
    atLocation: { token: "Area18", at: Date.now() - 30 * 60_000 },
    system: "stanton",
  });
  const CAP = 5;   // what `versefinder.html` actually asks for
  const tiersOf = (qs: any[]) => {
    const m: Record<string, number> = {};
    for (const q of qs) m[q.containment ?? "null"] = (m[q.containment ?? "null"] ?? 0) + 1;
    return m;
  };
  const show = (m: Record<string, number>) =>
    Object.entries(m).map(([k, v]) => `${k}:${v}`).join(" · ");

  // The full ordered list, to know what the cap is choosing FROM.
  const full = get("/api/verse/search?q=medpen&shops=50", { locationSignals: signals });
  const hitFull = full.body.results[0];
  ok(!!hitFull, "the reported item is in the bundled table", hitFull?.name ?? "(none)");
  ok(full.body.order?.basis === "containment",
     "...on the containment basis Sub was actually on", full.body.order?.basis);

  const fullTiers = tiersOf(hitFull.quotes);
  // 🔴 POSITIVE FIRST, AND COUNTED STRAIGHT OFF THE TABLE RATHER THAN OFF A RESPONSE.
  // Asserting "the far tier exists" from a `shops=50` response is CIRCULAR: 157 > 50, so the one
  // out-of-system row only appears there because `reserveTierRows` put it there. A negative control
  // caught exactly that — gutting the rule turned this line red, which means it was measuring the
  // fix rather than the data it is supposed to vouch for. So the far shops are counted from
  // `item-shops.json` itself, which no part of the fix can reach.
  const rawTable = JSON.parse(readFileSync(join(DATA, "item-shops.json"), "utf8")) as
    { items: { n: string; q: { t: number }[] }[]; terminals: { sys: string | null }[] };
  const rawItem = rawTable.items.find((it) => it.n === hitFull.name);
  ok(!!rawItem, "the item is findable in the raw shipped table", hitFull.name);
  const offSystem = (rawItem?.q ?? [])
    .filter((q) => systemKey(rawTable.terminals[q.t]?.sys) !== "stanton").length;
  ok(offSystem > 0,
     "🔑 the SHIPPED TABLE really does sell it outside the player's system",
     `${offSystem} of ${rawItem?.q.length} price rows are not in Stanton`);
  ok((fullTiers["elsewhere"] ?? 0) > 0,
     "...and the route agrees there is an out-of-system tier to lose", show(fullTiers));
  ok(hitFull.shopCount > CAP, "...at far more shops than the cap shows",
     `${hitFull.shopCount} shops, cap ${CAP}`);

  // ── THE OLD BEHAVIOUR, driven rather than described: this is literally what `item-search`'s
  //    `.slice(0, perItem)` used to return. It is the bug, reproduced on real data.
  const plain = hitFull.quotes.slice(0, CAP);
  const plainTiers = tiersOf(plain);
  ok((plainTiers["elsewhere"] ?? 0) === 0,
     "🔴 a plain cap at 5 deletes EVERY out-of-system shop — the reported bug", show(plainTiers));
  ok((plainTiers["same-system"] ?? 0) === 0,
     "...and the whole same-system tier with it, which nothing on screen could have said",
     show(plainTiers));

  // ── THE FIX, on the wire, through the real handler at the real cap.
  const capped = get(`/api/verse/search?q=medpen&shops=${CAP}`, { locationSignals: signals });
  const hit = capped.body.results[0];
  const tiers = tiersOf(hit.quotes);
  ok((tiers["elsewhere"] ?? 0) > 0,
     "🔴 an out-of-system shop reaches the wire at the cap the widget uses", show(tiers));
  ok((tiers["same-system"] ?? 0) > 0,
     "...and so does the same-system tier the plain cap also lost", show(tiers));
  ok(Object.keys(tiers).length === Object.keys(fullTiers).length,
     "...so every tier that has an answer is represented",
     `${Object.keys(tiers).length} of ${Object.keys(fullTiers).length} tiers`);

  // ── AND THE NEAR HALF IS UNTOUCHED. "Things in the system should be at the top" is the other
  //    half of Sub's sentence, and a fix that reordered them would have broken it.
  ok(hit.quotes.slice(0, CAP).map((q: any) => q.terminal).join("|") ===
     plain.map((q: any) => q.terminal).join("|"),
     "...while the first 5 rows are exactly what they were before",
     hit.quotes.slice(0, CAP).map((q: any) => q.place).join(", "));
  ok(hit.quotes.length === CAP + 2,
     "...and the list grew by the two rescued rows, nothing more", `${hit.quotes.length} rows`);

  // 🔑 `shopCount` must STILL be the full figure, because the widget subtracts the drawn rows from
  // it to say "+N more shops". If the reserve had inflated it, that note would under-report.
  ok(hit.shopCount === hitFull.shopCount,
     "...and shopCount is still the whole population, so '+N more' stays honest",
     `${hit.shopCount} both ways`);
}

rmSync(userDir, { recursive: true, force: true });
console.log(`\n${fail ? `FAILED (${fail})` : "all passed"}  ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
