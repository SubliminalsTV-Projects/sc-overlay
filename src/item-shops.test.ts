/**
 * THE SHOP TABLE'S REFUSALS.  `npm run test:itemshopstore`
 *
 * 🔴 EVERY RULE IN HERE IS ABOUT A FETCH THAT SUCCEEDED AND SHOULD STILL BE THROWN AWAY, which is
 * the class of failure this module is most exposed to and the one nothing was covering. A 500 is
 * easy — it throws, the previous table stands, the footer says so. The dangerous responses are the
 * ones that arrive HTTP 200, parse cleanly, and quietly contain less than they should:
 *
 *   an empty table      the endpoint is up but its own UEX poll failed, or it is mid-deploy;
 *   a malformed table   a half-written cache file, or a shape change nobody noticed;
 *   an OLDER schema     the site has not deployed the release this build was cut for.
 *
 * The third is the one that motivated the file. A schema-1 site serves a perfectly well-formed
 * 2,791-item table with no vehicles in it, so an app on schema 2 refreshing against it would
 * replace a bundle carrying 179 ships with one carrying none, report `source: "live"`, and look
 * completely healthy while every ship had vanished from the widget.
 *
 * 🔑 `fetchImpl` exists on the store for exactly this, so none of this touches the network.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ItemShopStore, ITEM_SHOPS_SCHEMA } from "./item-shops.js";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, detail = "") => {
  if (c) { pass++; console.log(`ok    ${name}${detail ? "  [" + detail + "]" : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  [" + detail + "]" : ""}`); }
};

const DATA = join(process.cwd(), "data");

/** A minimal but VALID table, at whatever schema is asked for. */
function payload(schema: number, itemName: string) {
  return {
    schema,
    fetchedAt: 1_700_000_000_000,
    terminals: [{ n: "Test Terminal", sys: "Stanton", body: "ArcCorp", place: "Area 18" }],
    items: [{ n: itemName, co: "TestCo", c: "Cat", s: "Sec", z: null, u: null, q: [{ t: 0, p: 100, m: 1_700_000_000 }] }],
    droppedOffline: 0,
    catalogueOnly: 1,
    unpriced: [["Unsold Thing", "Full Set"]],
  };
}

function stubFetch(body: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

function store(fetchImpl: typeof fetch) {
  const stateDir = mkdtempSync(join(tmpdir(), "itemshops-test-"));
  return { s: new ItemShopStore({ dataDir: DATA, stateDir, url: "https://example.invalid/t", fetchImpl }), stateDir };
}

/* ── The bundle is the floor, and the tests below all start from it ────────────────────────── */

console.log("\nthe shipped bundle is what a store starts from");
{
  const { s, stateDir } = store(stubFetch(null));
  const t = s.current();
  ok(t.source === "bundled", "a fresh profile reads the bundle", t.source);
  // 🔑 Positive first. Every refusal assertion below is "the table did not change", which is
  // satisfied for free by a table that was empty to begin with.
  ok(t.items.length > 2000, "...and it really has a table in it", `${t.items.length} items`);
  const ships = t.items.filter((i) => i.s === "Vehicles");
  ok(ships.length > 100, "🔴 ...including ships, which is what the refusals below protect",
     `${ships.length} vehicles`);
  ok(t.unpriced.length > 1000, "...and the names of the items nobody sells", `${t.unpriced.length}`);
  rmSync(stateDir, { recursive: true, force: true });
}

/* ── Refusal 1: a 200 carrying nothing ─────────────────────────────────────────────────────── */

console.log("\na successful fetch of an EMPTY table is not a success");
{
  const { s, stateDir } = store(stubFetch({ schema: ITEM_SHOPS_SCHEMA, items: [], terminals: [] }));
  const before = s.current().items.length;
  const after = await s.refresh();
  ok(after.items.length === before, "the previous table stands", `${before} -> ${after.items.length}`);
  ok(after.source === "bundled", "🔴 ...and it is NOT relabelled live", after.source);
  ok(!!after.lastError, "...with a reason on the record, so the footer can say why", after.lastError ?? "");
  rmSync(stateDir, { recursive: true, force: true });
}

/* ── Refusal 2: an older schema ────────────────────────────────────────────────────────────── */

console.log("\nan OLDER schema is a fetch that loses data");
{
  const { s, stateDir } = store(stubFetch(payload(ITEM_SHOPS_SCHEMA - 1, "Old Schema Widget")));
  const before = s.current();
  const shipsBefore = before.items.filter((i) => i.s === "Vehicles").length;
  const after = await s.refresh();
  ok(after.source === "bundled", "🔴 a schema-behind endpoint is refused, not adopted", after.source);
  ok(after.items.length === before.items.length, "...the table is unchanged",
     `${before.items.length} -> ${after.items.length}`);
  // ⚠️ The detail prints the AFTER count, not the before. The first version printed `shipsBefore`
  // and the negative control duly went red reading "179" — the number that was still correct —
  // which tells a reader nothing about what went wrong. A detail is only useful if it names the
  // thing that moved.
  const shipsAfter = after.items.filter((i) => i.s === "Vehicles").length;
  ok(shipsAfter === shipsBefore, "🔴 ...so the ships are still there", `${shipsBefore} -> ${shipsAfter}`);
  ok(!after.items.some((i) => i.n === "Old Schema Widget"), "...and nothing from it leaked in");
  ok((after.lastError ?? "").indexOf("schema") > -1, "...saying it was the schema", after.lastError ?? "");
  rmSync(stateDir, { recursive: true, force: true });
}

/* ── ...but the CURRENT schema is adopted, or the guard would be a way of never updating ───── */

console.log("\nthe matching schema is adopted normally");
{
  const { s, stateDir } = store(stubFetch(payload(ITEM_SHOPS_SCHEMA, "Live Only Widget")));
  const after = await s.refresh();
  ok(after.source === "live", "🔴 a current payload really is taken", after.source);
  ok(after.items.length === 1 && after.items[0].n === "Live Only Widget",
     "...and it replaces the table", `${after.items.length} items`);
  ok(after.lastError === null, "...with no error recorded", String(after.lastError));
  ok(after.unpriced.length === 1 && after.unpriced[0].n === "Unsold Thing",
     "...unpriced names decoded off the wire's pairs", JSON.stringify(after.unpriced));
  ok(existsSync(join(stateDir, "item-shops.json")), "...and it is cached for the next session");
  // The cache round-trips the pairs, or a restart would silently lose the names.
  const cached = JSON.parse(readFileSync(join(stateDir, "item-shops.json"), "utf8")) as { unpriced?: unknown };
  ok(Array.isArray(cached.unpriced) && (cached.unpriced as unknown[]).length === 1,
     "🔑 ...as PAIRS, so a restart still knows the names", JSON.stringify(cached.unpriced));
  rmSync(stateDir, { recursive: true, force: true });
}

/* ── A NEWER schema is fine — refusing the future strands every shipped build ──────────────── */

console.log("\na NEWER schema is accepted, extra fields ignored");
{
  const body = { ...payload(ITEM_SHOPS_SCHEMA + 1, "Future Widget"), somethingNew: [1, 2, 3] };
  const { s, stateDir } = store(stubFetch(body));
  const after = await s.refresh();
  ok(after.source === "live", "🔴 the app does not refuse a site that has moved ahead", after.source);
  ok(after.items[0]?.n === "Future Widget", "...and reads what it understands", after.items[0]?.n);
  rmSync(stateDir, { recursive: true, force: true });
}

/* ── Rental quotes survive the wire, and only rentals carry the marker ─────────────────────── */

console.log("\nk: rent survives normalise, and nothing else grows one");
{
  const body = payload(ITEM_SHOPS_SCHEMA, "Test Hull");
  body.items[0].q = [
    { t: 0, p: 1_000_000, m: 1_700_000_000 },
    { t: 0, p: 30_000, m: 1_700_000_000, k: "rent" },
    { t: 0, p: 40_000, m: 1_700_000_000, k: "lease" },
  ] as never;
  const { s, stateDir } = store(stubFetch(body));
  const after = await s.refresh();
  const q = after.items[0].q;
  ok(q.length === 3, "every priced quote survives", `${q.length}`);
  ok(q.filter((x) => x.k === "rent").length === 1, "🔴 exactly the one rental keeps its marker",
     q.map((x) => x.k ?? "buy").join(","));
  // 🔴 An unrecognised kind must not become a PURCHASE by default — that is the wrong way round to
  // be safe. It is narrowed to nothing we claim, which the widget then draws as an ordinary row.
  ok(q.filter((x) => x.k === undefined).length === 2, "...and an unknown kind is not invented into one",
     q.map((x) => String(x.k)).join(","));
  // 🔴 Purchases sort ahead of rentals, or "cheapest first" reads as the price of the ship — the
  // 30,000 rental would lead a 1,000,000 hull.
  // ⚠️ Asserted as "no rental appears before a purchase", not as "q[0].p is one of two numbers".
  // The first draft was that disjunction, which is as weak as its weakest half and would have
  // passed on an order it was written to reject.
  const firstRent = q.findIndex((x) => x.k === "rent");
  const lastBuy = q.map((x) => x.k).lastIndexOf(undefined);
  ok(firstRent > lastBuy, "🔴 every purchase precedes every rental",
     q.map((x) => x.p + (x.k ? ":" + x.k : "")).join(" "));
  ok(q[0].k === undefined && q[q.length - 1].k === "rent",
     "...so a purchase leads and the rental is last",
     q.map((x) => x.k ?? "buy").join(","));
  rmSync(stateDir, { recursive: true, force: true });
}

/* ── A dead endpoint keeps the table and says so ───────────────────────────────────────────── */

console.log("\nan outage keeps the table rather than blanking the widget");
{
  const { s, stateDir } = store((async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch);
  const before = s.current().items.length;
  const after = await s.refresh();
  ok(after.items.length === before, "the table survives", `${before} -> ${after.items.length}`);
  ok((after.lastError ?? "").indexOf("ECONNREFUSED") > -1, "...and the reason is kept", after.lastError ?? "");
  rmSync(stateDir, { recursive: true, force: true });
}

/* ── A configured-off store is a supported state, not an error ─────────────────────────────── */

console.log("\nrefreshing can be switched off entirely");
{
  const stateDir = mkdtempSync(join(tmpdir(), "itemshops-test-"));
  const s = new ItemShopStore({ dataDir: DATA, stateDir, url: "" });
  ok(!s.canRefresh(), "an empty url disables refreshing");
  const after = await s.refresh();
  ok(after.lastError === null, "...and that is not an error state", String(after.lastError));
  ok(after.source === "bundled" && after.items.length > 2000, "...the bundle still answers",
     `${after.items.length}`);
  rmSync(stateDir, { recursive: true, force: true });
}

/* ── A corrupt cache must not beat the bundle ──────────────────────────────────────────────── */

console.log("\na half-written cache is discarded WHOLE, never partially trusted");
{
  const stateDir = mkdtempSync(join(tmpdir(), "itemshops-test-"));
  writeFileSync(join(stateDir, "item-shops.json"), '{"items":[{"n":"Broken","q":[{"t":99,"p":5,"m":1}]}],"terminals":[]}');
  const s = new ItemShopStore({ dataDir: DATA, stateDir, url: "" });
  const t = s.current();
  ok(t.source === "bundled", "🔴 it falls through to the bundle", t.source);
  ok(!t.items.some((i) => i.n === "Broken"), "...and nothing from it is kept");
  rmSync(stateDir, { recursive: true, force: true });
}

console.log(`\n${fail ? `FAILED (${fail})` : "all passed"}  ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
