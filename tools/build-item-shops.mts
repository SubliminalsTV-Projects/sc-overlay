/**
 * REGENERATE `data/item-shops.json` — the Verse Finder's offline floor.
 *
 * 🔴 WHY THIS EXISTS. The bundle shipped as a HAND-CAPTURED snapshot: someone called the endpoint
 * once and pasted the response into the repo. That works exactly once. It has no script behind it,
 * so it ages silently, and the thing it ages into is the tier a player falls back to when they
 * have no network — the one case where nobody is watching. `verse` flagged this as the single
 * loose end it left; this is that loose end closed.
 *
 * Same reasoning as `check-dataset-fresh.mjs`, whose header says it best: a documented per-release
 * step with no alarm on it is a step that eventually gets skipped.
 *
 * -- WHERE THE DATA COMES FROM, and why not from UEX directly -------------------------------
 *
 * 🔴 THE UEX KEY MUST NEVER SHIP IN THE APP, which is why the site proxy exists at all. This
 * generator honours the same boundary for a second reason: the site's `lib/uex/items.ts` already
 * performs the `id_terminal` join, the offline-terminal drop and the catalogue merge. Pulling
 * from UEX here would be a SECOND implementation of that join, free to drift from the one the
 * live tier uses — and then the bundled tier and the live tier would answer differently, which is
 * precisely the bug the bundle exists to avoid. So: one join, on the site, and this reads its
 * output. No key is needed here and none should be added.
 *
 * -- THE SAFETY PROPERTY THAT MATTERS MOST -------------------------------------------------
 *
 * 🔴 `ItemShopStore` REJECTS A MALFORMED TABLE **WHOLE** — `normalise()` returning null yields
 * `emptyTable("bundled")`, not a partial one. So a bundle this script gets subtly wrong does not
 * degrade, it VANISHES: the app ships with no offline data and says only "bundled, 0 items".
 * A generator that can write such a file is worse than no generator.
 *
 * 🔑 The defence is NOT to re-implement `normalise()`'s rules here — a copy is free to drift from
 * the original, and drift is the whole failure mode. Instead this script writes the file and then
 * loads it back through the REAL `ItemShopStore`, asserting the table comes out populated with the
 * counts we expect. What is verified is the actual runtime path, so it cannot disagree with it.
 *
 * -- USAGE ----------------------------------------------------------------------------------
 *
 *   npm run build:itemshops              # fetch, verify, write data/item-shops.json
 *   npm run build:itemshops -- --check   # write nothing; report how far behind the bundle is
 *   npm run check:itemshops              # the above, --strict (exit 1 when stale) — for release
 *
 *   --url <u>   read from somewhere else (a local site dev server, a staging deploy)
 *   --force     write even when the regression guard objects. Say why in the commit.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ItemShopStore, ITEM_SHOPS_SCHEMA } from "../src/item-shops.js";
import { DEFAULT_VERSE_URL } from "../src/verse-routes.js";

const argv = process.argv.slice(2);
const has = (f: string) => argv.includes(f);
const val = (f: string) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

const URL_ = val("--url") ?? DEFAULT_VERSE_URL;
const CHECK = has("--check");
const STRICT = has("--strict");
const FORCE = has("--force");
const OUT = join(process.cwd(), "data", "item-shops.json");

/** The endpoint polls UEX on demand and a cold call really does take ~35s (measured 2026-08-21).
 *  A short timeout here reads as "the site is down" when it is merely working. */
const FETCH_TIMEOUT_MS = 120_000;

/** 🔑 How far behind the live table the bundle may fall before a release should stop and refresh.
 *
 *  Not an arbitrary round number. The evidence that stale item prices are still TRUSTWORTHY is a
 *  measurement over one month — 23,658 of 23,747 rows never once moved in that window. Beyond a
 *  month the bundle is outside the window that evidence was gathered in, so the honest thing is to
 *  stop leaning on it. The catalogue is the other half: new items arrive with each game patch, and
 *  a bundle that predates a patch simply cannot know them. */
const MAX_DRIFT_DAYS = 30;

/** Refuse to replace a healthy bundle with a much smaller one. An upstream that is UP but
 *  partially broken (its own UEX poll half-failed, a category sweep timed out) serves a valid,
 *  well-formed, SMALLER table — and a well-formed small table sails past every structural check
 *  there is. Size is the only thing that catches it. */
const MAX_SHRINK = 0.1;

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};
const days = (ms: number) => ms / 86_400_000;
const mb = (n: number) => (n / 1048576).toFixed(2) + " MB";
const ago = (ms: number) => {
  const d = days(ms);
  return d < 1 ? `${Math.round(d * 24)}h` : `${d.toFixed(1)}d`;
};

interface Payload {
  schema?: number;
  fetchedAt?: number | null;
  items?: unknown[];
  terminals?: unknown[];
  droppedOffline?: number;
  catalogueOnly?: number;
  bundledAt?: number;
}

function readLocal(): Payload | null {
  try {
    return JSON.parse(readFileSync(OUT, "utf8")) as Payload;
  } catch {
    return null;
  }
}

/** Load a written file through the real runtime, with a stateDir that is guaranteed EMPTY.
 *
 *  ⚠️ The cache and the bundle share the filename `item-shops.json`, and the constructor prefers
 *  the cache. Pointing stateDir anywhere that already holds one would verify the CACHE and report
 *  a pass for a bundle it never read. A fresh temp dir is what makes this a real check. */
function verifyThroughStore(dir: string) {
  const stateDir = mkdtempSync(join(tmpdir(), "itemshops-verify-"));
  try {
    const table = new ItemShopStore({ dataDir: dir, stateDir, url: null }).current();
    return {
      source: table.source,
      items: table.items.length,
      terminals: table.terminals.length,
      quotes: table.items.reduce((n, it) => n + it.q.length, 0),
      fetchedAt: table.fetchedAt,
    };
  } finally {
    rmSync(stateDir, { recursive: true, force: true });
  }
}

// -- --check: how far behind is the bundle? -------------------------------------------------

if (CHECK) {
  const local = readLocal();
  if (!local) die(`item-shops check: cannot read ${OUT}`);
  const localFetched = typeof local!.fetchedAt === "number" ? local!.fetchedAt : null;
  console.log(
    `bundled: ${(local!.items ?? []).length} items, ${(local!.terminals ?? []).length} terminals` +
      (localFetched ? `, polled ${ago(Date.now() - localFetched)} ago` : ", no fetchedAt"),
  );

  // Range-request just the header. The file is ~1.2 MB and this runs on every release.
  // ⚠️ Only `fetchedAt` is reachable this way — `items` is a huge array at the FRONT of the
  // object, so the counts at the tail cannot be had without downloading everything.
  let remoteFetched: number | null = null;
  try {
    const res = await fetch(URL_, {
      headers: { Range: "bytes=0-2047", Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const head = await res.text();
    const m = /"fetchedAt"\s*:\s*(\d+)/.exec(head);
    if (!m) throw new Error("no fetchedAt in the served header");
    remoteFetched = Number(m[1]);
  } catch (e) {
    // Offline is not a failure. A release must not be blocked by the network — but silence would
    // read as a pass, so say it loudly. Same policy as check-dataset-fresh.mjs.
    console.warn(`item-shops check: SKIPPED, could not reach ${URL_} (${(e as Error).message})`);
    process.exit(0);
  }

  console.log(`live:    polled ${ago(Date.now() - remoteFetched!)} ago`);
  if (localFetched == null) {
    console.log("item-shops check: bundle has no fetchedAt — cannot compare. Regenerate.");
    process.exit(STRICT ? 1 : 0);
  }
  const drift = days(remoteFetched! - localFetched);
  if (drift <= MAX_DRIFT_DAYS) {
    console.log(`item-shops check: current (${drift.toFixed(1)}d behind live, limit ${MAX_DRIFT_DAYS}d).`);
    process.exit(0);
  }
  console.error(
    `\nitem-shops check: STALE. The bundle is ${drift.toFixed(1)} days behind the live table ` +
      `(limit ${MAX_DRIFT_DAYS}).\n` +
      `This is the tier a player falls back to with no network, so it ages where nobody is looking.\n` +
      `Refresh it:\n  npm run build:itemshops\n`,
  );
  process.exit(STRICT ? 1 : 0);
}

// -- the generator ---------------------------------------------------------------------------

console.log(`fetching ${URL_}`);
const started = Date.now();
let body: Payload;
try {
  const res = await fetch(URL_, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  body = (await res.json()) as Payload;
} catch (e) {
  die(`item-shops: fetch failed — ${(e as Error).message}\nNothing written; the existing bundle stands.`);
}

const items = Array.isArray(body!.items) ? body!.items : [];
const terminals = Array.isArray(body!.terminals) ? body!.terminals : [];
console.log(
  `  ${((Date.now() - started) / 1000).toFixed(1)}s — ${items.length} items, ${terminals.length} terminals`,
);

// 🔴 A 200 carrying an empty table is not a success. The site serves a stale copy through an
// upstream failure by design, but a genuinely empty one would REPLACE a good bundle with nothing.
if (!items.length || !terminals.length) {
  die("item-shops: the endpoint returned an empty table. Nothing written.");
}

const prev = readLocal();
const prevItems = (prev?.items ?? []).length;
const prevTerms = (prev?.terminals ?? []).length;

if (prevItems) {
  const shrink = (prevItems - items.length) / prevItems;
  if (shrink > MAX_SHRINK && !FORCE) {
    die(
      `\nitem-shops: REFUSING to write — the new table is ${(shrink * 100).toFixed(1)}% smaller ` +
        `(${prevItems} -> ${items.length} items).\n` +
        `A partially-broken upstream serves a valid, well-formed, smaller table, and no structural\n` +
        `check can tell that apart from a real shrink. Look at the endpoint before overriding.\n` +
        `If the drop is genuine (a UEX purge, a category retired): --force\n`,
    );
  }
}

// Write exactly the fields the store reads, plus two that document the file for a human.
// ⚠️ `bundledAt` is NOT read by `ItemShopStore` — it records when the SNAPSHOT was taken, which
// `fetchedAt` (when UEX was polled) does not. Nothing may come to depend on it.
const out = {
  schema: ITEM_SHOPS_SCHEMA,
  fetchedAt: typeof body!.fetchedAt === "number" ? body!.fetchedAt : Date.now(),
  items,
  terminals,
  droppedOffline: typeof body!.droppedOffline === "number" ? body!.droppedOffline : 0,
  catalogueOnly: typeof body!.catalogueOnly === "number" ? body!.catalogueOnly : 0,
  bundledAt: Date.now(),
};

// Verify BEFORE clobbering the good bundle: write to a temp dir, load it through the real store,
// and only then commit it to `data/`.
const stage = mkdtempSync(join(tmpdir(), "itemshops-stage-"));
try {
  writeFileSync(join(stage, "item-shops.json"), JSON.stringify(out));
  const v = verifyThroughStore(stage);

  if (v.source !== "bundled") die(`item-shops: verification read the ${v.source} tier, not the bundle. Aborted.`);
  if (!v.items) {
    die(
      "\nitem-shops: REFUSING to write — ItemShopStore rejected the table and returned 0 items.\n" +
        "`normalise()` discards a bad table WHOLE, so this file would have shipped as a silent\n" +
        "absence of offline data. The payload's shape has changed; reconcile item-shops.ts with\n" +
        "the site's route before regenerating.\n",
    );
  }
  // The store drops items whose quotes are all unrenderable. A few is normal; a lot means the
  // shape moved. Report it either way rather than letting it pass unremarked.
  const dropped = items.length - v.items;
  if (dropped > 0) console.log(`  note: the store dropped ${dropped} item(s) with no renderable quote`);

  writeFileSync(OUT, JSON.stringify(out));
  const size = readFileSync(OUT).length;

  const d = (now: number, before: number) => (now === before ? "" : ` (${now > before ? "+" : ""}${now - before})`);
  console.log(
    `\nwrote ${OUT}  ${mb(size)}\n` +
      `  items      ${v.items}${d(v.items, prevItems)}\n` +
      `  terminals  ${v.terminals}${d(v.terminals, prevTerms)}\n` +
      `  quotes     ${v.quotes}\n` +
      `  offline rows dropped upstream: ${out.droppedOffline}\n` +
      `  catalogue items with no known shop: ${out.catalogueOnly}\n` +
      `  verified by loading it back through ItemShopStore (source=${v.source}).`,
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}
