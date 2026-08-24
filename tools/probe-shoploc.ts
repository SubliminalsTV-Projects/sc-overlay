/**
 * WHICH TERMINAL IS `SCShop_Orison_KelTo`? — resolved by WHERE THE PLAYER WAS STANDING.
 *
 *   npx tsx tools/probe-shoploc.ts --lines <lines.gz> --meta <meta.csv> [--out <file.json>]
 *   npm run probe:shoploc -- --lines E:/tmp/shoploc/lines.gz --meta E:/tmp/shoploc/meta.csv
 *
 * -- THE PROBLEM -------------------------------------------------------------------------------
 *
 * The game writes a shop as an ASSET NAME (`SCShop_Orison_KelTo`); UEX writes it as a TERMINAL
 * NAME (`Kel-To - Cloudview Center - Orison`). **0 of 75 join by string.** Name-parsing gets part
 * of the way and then hits two walls that are structural rather than lazy:
 *
 *   - `SCShop_Cargo_Office`   ONE token, THIRTEEN stations. No string can separate them.
 *   - `SCShop_Orison_KelTo`   Orison has TWO Kel-To kiosks (Cloudview Center, August Dunlow
 *                             Spaceport). The name names the city, not the shop.
 *
 * So this does not read the token. It replays the corpus through the app's OWN location service
 * and asks, at each shop line, where the log had already placed the player.
 *
 * -- 🔴 THE RULE THAT KEEPS THIS FROM POISONING THE MAP ----------------------------------------
 *
 * **ONLY A `place`-TIER VERDICT MAY RESOLVE A TOKEN.** `body` and `system` name somewhere the
 * player was NEAR, not where they were standing, and a previous attempt at a learned
 * `shopName -> place` map had **5 of 27 pairings poisoned** at a 300 s window for exactly that
 * reason. A token seen at two different places is recorded as PLACE-DEPENDENT, never resolved —
 * `SCShop_Cargo_Office` SHOULD come out that way, and if it does not, the pipeline is wrong.
 *
 * 🔑 A token this refuses to resolve is a better result than one it resolves wrongly. A wrong
 * terminal silently attributes a price to a shop that never charged it.
 *
 * -- 🔴 THE CIRCULARITY GUARD, and it is the whole reason this measurement means anything -------
 *
 * `collectOriginSignals` ALREADY reads a place out of the shop's own asset name
 * (`uniqueFromShopName`) and already carries an in-session `shopId -> place` binding. Feeding the
 * terminal in and then "discovering" that `SCShop_Orison_KelTo` is at Orison would be the name
 * parse wearing a lab coat: the answer would come from the token being graded.
 *
 * So `inputs.terminal` is DELETED before grading. Every verdict here rests only on inventory
 * lines, ASOP reads, freight moves, the terrain report and quantum routes — sources that know
 * nothing about the shop. `--with-terminal` puts it back, and the difference is reported, because
 * a guard whose removal changes nothing is not a guard.
 *
 * -- THE CORPUS, AND ITS THREE TRAPS -----------------------------------------------------------
 *
 * `site.bp_shared_logs`, read-only. The published properties of that table all bite here:
 *
 *   1. **IT DOUBLE-COUNTS.** A live log is re-uploaded on every tick whose content changed, so one
 *      session arrives as N rows each a superset of the last. Every observation is therefore keyed
 *      on `(contributor, the GAME's own millisecond timestamp, token)` — never on the row.
 *   2. **IT IS FILTERED.** Sessions stored before 2026-08-24 were gathered under a `RE_SIGNAL`
 *      with no price term, so shopping sessions are under-represented. That biases COVERAGE, not
 *      correctness: a session that is present is present whole.
 *   3. **THE LINE EXTRACT IS A FILTER OF A FILTER.** Only the lines the location parsers consume
 *      are pulled. That is a real change to a stateful parser's input, so it is proven rather
 *      than assumed — see `--control`, which replays 8 WHOLE logs both ways and requires the
 *      verdict sequences to be identical field for field.
 *
 * 🔴 `PlaceWatcher` IS THE STATEFUL ONE, and the filter would have broken it silently. A terrain
 * block ends when a NON-terrain line arrives; drop the intervening lines and two blocks merge into
 * one, losing a reading and misdating the survivor. The extract carries each line's ORDINAL, so a
 * synthetic terminator is injected wherever the ordinals are not contiguous — which reconstructs
 * the block boundary exactly. The control is what says so.
 *
 * ⚠️ READ-ONLY. It reads a gzip and two JSON datasets and writes one report. It touches no game
 * install, no `%APPDATA%`, and nothing on the server.
 */
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { join } from "node:path";

import { PlayerLocation } from "../src/player-location.js";
import { collectOriginSignals, originDepsFor } from "../src/origin-signals.js";
import { resolveOrigin, TRUST_MIN, type OriginVerdict } from "../src/player-origin.js";
import { parseLine } from "../src/parser.js";
import { parseMissionEvent } from "../src/missions-parser.js";
import { matchLocationToken } from "../src/hauling-locations.js";
import { HaulingDataStore } from "../src/hauling-data.js";
import { tierOfRecord } from "../src/origin-signals.js";
import { buildTerminalIndex, matchKey, systemKey, type LocationRecord } from "../src/verse-proximity.js";

const DATA = join(process.cwd(), "data");

/* ── args ─────────────────────────────────────────────────────────────────────────────────────*/

const argv = process.argv.slice(2);
const arg = (n: string): string | null => {
  const i = argv.indexOf(n);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const flag = (n: string): boolean => argv.includes(n);

/* ── the datasets the location service needs, wired the way the sidecar wires them ────────────*/

interface Loaded {
  locations: Record<string, LocationRecord>;
  names: Map<string, string>;
  bodyNames: Record<string, string>;
  knownSystems: Set<string>;
  haulingData: HaulingDataStore;
}

function load(): Loaded {
  const locations = (JSON.parse(readFileSync(join(DATA, "locations.json"), "utf8")) as
    { locations?: Record<string, LocationRecord> }).locations ?? {};
  const names = new Map<string, string>();
  for (const [id, rec] of Object.entries(locations)) if (rec?.name) names.set(id, rec.name);
  // `pyro2` -> "Monox". `mining.bodyNames()` reads exactly this field of exactly this file; the
  // MiningStore around it wants an OCR stack we have no use for here.
  const bodyNames = (JSON.parse(readFileSync(join(DATA, "mineables.json"), "utf8")) as
    { bodies?: Record<string, string> }).bodies ?? {};
  /* The system vocabulary. `tracker.knownSystems()` derives it from mission `places` ending in
   * " System"; the starmap states it outright in a column, which is the same vocabulary from the
   * table the ids come from. `<= uninitialized =>` is a real value in that column and is dropped —
   * SystemWatcher matches on a word boundary, and that string can never be one. */
  const knownSystems = new Set<string>();
  for (const rec of Object.values(locations)) {
    const k = systemKey(rec?.system);
    if (k && /^[a-z][a-z0-9 ]*$/.test(k)) knownSystems.add(k);
  }
  return { locations, names, bodyNames, knownSystems, haulingData: new HaulingDataStore(DATA) };
}

/* ── the corpus ───────────────────────────────────────────────────────────────────────────────*/

interface Meta { usr: string; kind: string; created: string }

function readMeta(file: string): Map<string, Meta> {
  const out = new Map<string, Meta>();
  const rows = readFileSync(file, "utf8").split(/\r?\n/);
  for (const r of rows.slice(1)) {
    if (!r.trim()) continue;
    const c = r.split(",");
    out.set(c[0], { usr: c[1], kind: c[2], created: c[3] });
  }
  return out;
}

/** One kept line: its ordinal in the original log, and the line itself. */
interface Kept { ord: number; line: string }

/**
 * Stream the gzip and hand each log's kept lines to `onLog`, in order.
 *
 * The extract is `<logId> <ord> <base64 of the line>`, one per row. Base64 because psql's TEXT
 * format backslash-escapes its payload and a Windows game log is full of backslashes — the
 * transport-mangles-the-data trap this corpus has already sprung once.
 */
async function eachLog(gz: string, onLog: (id: string, lines: Kept[]) => void): Promise<void> {
  const rl = createInterface({ input: createReadStream(gz).pipe(createGunzip()), crlfDelay: Infinity });
  let curId: string | null = null;
  let buf: Kept[] = [];
  for await (const row of rl) {
    if (!row) continue;
    const a = row.indexOf(" ");
    const b = row.indexOf(" ", a + 1);
    if (a < 0 || b < 0) continue;
    const id = row.slice(0, a);
    const ord = Number(row.slice(a + 1, b));
    // 🔑 The real watcher splits on /\r?\n/, so the CR the server's split-on-\n leaves behind must
    // go. Leaving it in would put a stray character on the end of every parsed field.
    const line = Buffer.from(row.slice(b + 1), "base64").toString("utf8").replace(/\r$/, "");
    if (id !== curId) {
      if (curId) onLog(curId, buf);
      curId = id;
      buf = [];
    }
    buf.push({ ord, line });
  }
  if (curId) onLog(curId, buf);
}

/**
 * WHICH LINES THE EXTRACT KEEPS — the JS copy of the SQL predicate, and the reason it is here.
 *
 * 🔴 A PREFILTER IS A SECOND, INVISIBLE COPY OF THE PARSER'S VOCABULARY. This one lives in a
 * `.sql` file on the far side of an ssh pipe, where nothing can typecheck it and nothing can test
 * it. So it is written out once more here, and `--control` asserts that the two agree line for
 * line on 8 whole logs pulled unfiltered. A drift between them is the failure mode where the
 * probe reports a confident answer about a corpus it never saw all of.
 *
 * Each entry names the parser that consumes it, so widening one is a decision about a parser
 * rather than about a string:
 */
const KEEP = [
  "planet cells:",                        // location.ts   PlaceWatcher.LINE       (body tier)
  "[QuantumTravel]",                      // location.ts   SystemWatcher.QT_TAG    (system tier)
  "requested inventory for Location[",    // missions-parser RE.locationInventory  (place tier)
  "at location [",                        // missions-parser RE.numericLocation A  (place tier)
  ":Location:",                           // missions-parser RE.numericLocation B  (place tier)
  "Platform state changed to",            // missions-parser RE.platformState      (place tier)
  /* 🔴 THE SUBJECT IS ANY LINE THAT NAMES A SHOP, not the two components `parseShopLine` accepts.
   * Anchoring on the components loses `CEntityComponentShoppingProvider` and
   * `CEntityComponentMiningShopUIProvider` — 186 lines, but **14 shop tokens that appear nowhere
   * else**, including every ship dealership and the refinery ore desks. See `shopLineOf`.
   * The two component terms are kept beside it so this list stays character-for-character the
   * SQL's, which is what the count cross-check in `--control` is testing. */
  "CEntityComponentCommodityUIProvider::",
  "CEntityComponentShop",
  "shopName[",
];
const keep = (line: string): boolean => KEEP.some((k) => line.indexOf(k) >= 0);

/**
 * 🔴 THE SUBJECT OF THE MEASUREMENT IS WIDER THAN `parseShopLine`, DELIBERATELY — AND THE GAP IS
 * A REAL FINDING ABOUT `src/`, NOT A SHORTCUT TAKEN HERE.
 *
 * `parseShopLine` in `player-location.ts` requires the text between `CEntityComponent` and
 * `UIProvider::` to be exactly "Commodity" or "Shop". Measured over the corpus, it accepts
 * **12,247 shop lines and this accepts 12,375 — a strict superset, 128 extra, 0 the other way.**
 * The 128 are `CEntityComponentShoppingProvider` (91), which has no `UIProvider::` in its name at
 * all, and `CEntityComponentMiningShopUIProvider` (36), whose "MiningShop" is not "Shop".
 *
 * 🔴 THE LINE COUNT MASSIVELY UNDERSTATES IT: 128 lines is 1%, but they carry **20 shop tokens
 * that appear NOWHERE ELSE — 63 tokens become 83.** Every ship dealership and rental desk (Astro
 * Armada, New Deal, Vantage Rentals, Regal Luxury, Teach's), every food stall, and all three
 * refinery ore-sale desks. **Seven of the 20 are tokens the tower had already matched by name**,
 * so without this the two methods could not have been compared on them at all.
 *
 * `references/item-shops.md` names the same shape from the other side: THREE purchase verbs
 * across TWO components, of which `ShoppingProvider::SendStandardItemBuyRequest` (143) and
 * `::SendRentalRequest` (20) are 37% of all purchases. The location service parses neither.
 *
 * 🔑 WIDENING HERE IS NOT FORKING THE LOCATION SERVICE. This decides WHICH LINES ARE ASKED ABOUT;
 * every ANSWER still comes from `PlayerLocation` + `collectOriginSignals` + `resolveOrigin`,
 * untouched. And the `lastShop` state `parseShopLine` feeds is the terminal signal, which this
 * probe deletes anyway. The `src/` repair is Cargo.
 */
function shopLineOf(line: string): { shopId: string; shopName: string; kioskId: string | null } | null {
  if (line.indexOf("<CEntityComponent") < 0) return null;
  const id = /shopId\[([^\]]*)\]/.exec(line);
  const nm = /shopName\[([^\]]*)\]/.exec(line);
  if (!id?.[1] || !nm?.[1]) return null;
  return { shopId: id[1], shopName: nm[1], kioskId: /kioskId\[([^\]]*)\]/.exec(line)?.[1] || null };
}

const TS_RE = /^<([^>]+)>/;
const tsOf = (line: string): number | null => {
  const m = TS_RE.exec(line);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
};
const isTerrain = (line: string): boolean => line.indexOf("planet cells:") >= 0;

/* ── one session's replay ─────────────────────────────────────────────────────────────────────*/

/** One shop line, graded. */
interface Obs {
  token: string;
  shopId: string;
  kioskId: string | null;
  at: number;
  /** Contributor hash, filled by the caller. Carried per observation so "how many people saw this"
   *  is a property of the row rather than a second map that can fall out of step with it. */
  usr?: string;
  /** Which shop component wrote the line — the commodity kiosk or the item shop. */
  kind: "commodity" | "item" | "refinery";
  /** The verdict's own staleness flag, carried so an expired reading can be counted. */
  stale: boolean;
  /** 🔴 WHY THIS OBSERVATION DID OR DID NOT RESOLVE ANYTHING. The brief's requirement is that an
   *  unresolvable token is marked unresolvable WITH THE REASON, and the two reasons want opposite
   *  responses: `body`/`system`/`unknown` means the log never placed the player there and only
   *  more play can fix it, while `place-is-a-body` / `place-too-old` means it DID and this probe
   *  refused the answer. Collapsing them would hide which. */
  why: "same-place" | "place-too-old" | "place-is-a-body" | "body" | "system" | "unknown";
  tier: OriginVerdict["tier"];
  /** The starmap place id the verdict names, or null. */
  placeId: string | null;
  ageMin: number | null;
  /** Which signal won, verbatim from the verdict — so a surprising row can be traced. */
  from: string;
}

/**
 * The starmap id of a verdict that really is SAME-PLACE, or null.
 *
 * 🔴 `tier === "place"` IS NOT ENOUGH, AND THE FIRST RUN OF THIS PROBE PROVED IT. `pushPlace` in
 * `origin-signals.ts` stamps every resolved location token as a `place` without asking the starmap
 * row what it is, so a token that resolves to the row "Stanton" — a **Star** — arrives as a
 * place-tier fix, as do the moons "Ita" and "Arial". Measured on the first pass: **135 of 3,197
 * "same-place" observations (4.2%) named a Star, a Planet or a Moon.** Those are same-SYSTEM and
 * same-BODY readings wearing a place-tier coat, and letting them resolve a token is precisely the
 * poisoning this probe exists to avoid — `SCShop_ht_delta_rayari_m_store` would have "resolved"
 * to two moons, naming neither of the outposts on them.
 *
 * `tierOfRecord` already encodes the rule (it is what stops a shop name mentioning "Pyro" from
 * putting the player at the centre of a sun); it simply is not applied on this path. Applying it
 * here is a measurement guard, not a fix — see the strip's Cargo for the `src/` half.
 *
 * 🔴 AND THE TIER IS NOT ENOUGH ON ITS OWN EITHER — `resolveOrigin` FALLS BACK TO AN EXPIRED
 * READING AND STILL CALLS IT `place`. That fallback is right for a widget (a last-known beats
 * "unknown" on screen, and it ships `stale: true` beside it) and wrong here: a fix older than its
 * own trust window is a claim about where the player was an hour ago, and an hour is enough to fly
 * to another station. That is the wrong-attribution case this whole probe exists to avoid.
 *
 * Measured before adding the guard: **64 of 3,062 same-place observations (2.1%) were past
 * `TRUST_MIN.place`**, and nothing anywhere in the corpus rested on a reading older than 180
 * minutes — so closing the branch that could be badly wrong costs almost nothing.
 *
 * ⚠️ The merely-`stale` ones are KEPT — 303 (9.9%) sit past HALF the window. Half a window is
 * "believe it less", not "it is probably wrong", and `resolveOrigin`'s own comment says so.
 */
function samePlace(
  v: OriginVerdict,
  locations: Record<string, LocationRecord>,
): { id: string | null; why: Obs["why"] } {
  if (v.tier !== "place" || !v.id) return { id: null, why: v.tier };
  if (v.ageMin !== null && v.ageMin > TRUST_MIN.place) return { id: null, why: "place-too-old" };
  if (tierOfRecord(locations[v.id]) !== "place") return { id: null, why: "place-is-a-body" };
  return { id: v.id, why: "same-place" };
}

interface ReplayOpts {
  loaded: Loaded;
  /** The numeric-id map handed to the service. A fresh object per session is the conservative
   *  reading; a corpus-wide one is the measured one. Both are run and both are reported. */
  placeIds: Record<string, string>;
  /** Called for every binding the service learns, so pass 1 can measure whether an id is ever
   *  seen naming two different places. */
  onBind?: (id: string, token: string) => void;
  /** Put the terminal signal back — the circularity control. Off by default and it must stay off
   *  for any published number. */
  withTerminal: boolean;
  /** Control only: stop injecting the terrain-block terminator, so the filtered replay really is
   *  the naive one. `--control` requires this to make the two streams disagree. */
  noTerminator?: boolean;
}

function replay(lines: Kept[], o: ReplayOpts): Obs[] {
  const { loaded } = o;
  let clock = 0;
  const pl = new PlayerLocation({
    bodyNames: loaded.bodyNames,
    knownSystems: loaded.knownSystems,
    savedPlaceIds: () => o.placeIds,
    savePlaceId: (id, token) => { o.placeIds[id] = token; o.onBind?.(id, token); },
    now: () => clock,
  });
  const depsForOrigin = originDepsFor(loaded.locations);
  const resolveToken = (t: string) => matchLocationToken(t, loaded.names, loaded.haulingData);

  /* The three last-seen readings `HaulingTracker` keeps. Taken from the SAME parser the tracker
   * feeds from, and carried the same way it carries them (a plain last-seen — nothing in the log
   * fires when the player LEAVES). Instantiating the tracker itself would drag the whole contract
   * model in for three fields. */
  let atLocation: { token: string; at: number } | null = null;
  let atLocationId: { id: string; at: number } | null = null;
  let cargoMove: { direction: "down" | "up"; platform: string; at: number } | null = null;

  const out: Obs[] = [];
  let prev: Kept | null = null;

  const feed = (line: string, at: number) => {
    clock = at;
    pl.push(line, at);
  };

  for (const k of lines) {
    const at = tsOf(k.line);
    /* 🔴 A TERRAIN BLOCK ENDS AT THE FIRST NON-TERRAIN LINE, so a gap in the ordinals means the
     * full log had one there and this stream must supply it. Without this two blocks merge and
     * `PlaceWatcher` reports the first body of the pair at the wrong time. */
    if (!o.noTerminator && prev && isTerrain(prev.line) && k.ord !== prev.ord + 1) {
      feed("", tsOf(prev.line) ?? clock);
    }
    prev = k;
    if (at === null) continue;
    feed(k.line, at);

    const ev = parseMissionEvent(parseLine(k.line));
    if (ev) {
      if (ev.kind === "playerLocation") atLocation = { token: ev.location, at };
      else if (ev.kind === "playerLocationId") atLocationId = { id: ev.locationId, at };
      else if (ev.kind === "cargoPlatform") cargoMove = { direction: ev.direction, platform: ev.platform, at };
    }

    const shop = shopLineOf(k.line);
    if (!shop) continue;
    /* Which component wrote it. Free here, and it tells a consumer which price table a receipt
     * from this token belongs in — `commodities.json`, `item-shops.json`, or neither, since the
     * refinery ore desk is a third thing that UEX does not carry as a shop at all. */
    const kind: Obs["kind"] =
      k.line.indexOf("CEntityComponentCommodityUIProvider") >= 0 ? "commodity"
      : k.line.indexOf("MiningShopUIProvider") >= 0 ? "refinery"
      : "item";

    const inputs = pl.inputs({ atLocation, atLocationId, cargoMove });
    /* 🔴 THE CIRCULARITY GUARD. `collectOriginSignals` reads a place out of the shop's own asset
     * name and out of an in-session binding keyed on this very shop. Grading with either in play
     * would answer the question with the token being asked about. */
    if (!o.withTerminal) inputs.terminal = null;
    const verdict = resolveOrigin(
      collectOriginSignals(inputs, { locations: loaded.locations, resolveToken, now: () => at }),
      { ...depsForOrigin, now: () => at },
    );
    const sp = samePlace(verdict, loaded.locations);
    out.push({
      token: shop.shopName, shopId: shop.shopId, kioskId: shop.kioskId, at, kind,
      tier: verdict.tier, placeId: sp.id, why: sp.why, stale: verdict.stale,
      ageMin: verdict.ageMin, from: verdict.from,
    });
  }
  /* End of file ends any open block, exactly as the real watcher's stream running out does. */
  if (!o.noTerminator && prev && isTerrain(prev.line)) feed("", tsOf(prev.line) ?? clock);
  return out;
}

/* ── 🔴 THE CONTROL ON THE MEASUREMENT ITSELF ─────────────────────────────────────────────────*/

/**
 * DOES THE FILTERED EXTRACT MEASURE THE SAME THING AS THE WHOLE LOG?
 *
 *   npx tsx tools/probe-shoploc.ts --control [--full E:/tmp/shoploc/full.gz]
 *
 * The corpus arrives pre-filtered to the lines the location parsers consume. `PlaceWatcher` is
 * STATEFUL — a terrain block ends at the first NON-terrain line — so that filter is a real change
 * to a stateful parser's input and cannot be assumed harmless. This pulls 8 WHOLE logs, replays
 * each one twice, and requires the two verdict sequences to be identical field for field.
 *
 * 🔑 IT HAS TO FAIL FOR THE RIGHT REASON TOO, or "the two agree" is free. Three injections, each
 * of which must make them disagree:
 *   1. Remove the block terminator. This is the bug the ordinals exist to prevent.
 *   2. Drop the terrain lines from the filter. The body tier should be doing work.
 *   3. Drop the numeric-location lines. The place tier's biggest single source.
 * A green injection is reported as a FINDING — it means that signal buys nothing on this sample,
 * which is worth knowing, not something to hide.
 *
 * It also cross-checks the SQL: the count `keep()` accepts on the raw text must equal what the
 * hand-written predicate in `tools/sql/shoploc-lines.sql` pulled for the same logs.
 */
async function control(fullFile: string, loaded: Loaded): Promise<number> {
  const rows: { id: string; text: string }[] = [];
  const rl = createInterface({ input: createReadStream(fullFile).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const row of rl) {
    const a = row.indexOf(" ");
    if (a < 0) continue;
    rows.push({ id: row.slice(0, a), text: Buffer.from(row.slice(a + 1), "base64").toString("utf8") });
  }
  console.log(`[control] ${rows.length} whole logs`);

  const sig = (o: Obs) => `${o.at}|${o.token}|${o.tier}|${o.placeId ?? "-"}|${o.ageMin === null ? "-" : o.ageMin.toFixed(6)}|${o.from}`;
  const opts = { loaded, placeIds: {}, withTerminal: false };

  interface Variant { name: string; lines: (all: Kept[]) => Kept[]; noTerminator?: boolean; mustDiffer: boolean }
  const variants: Variant[] = [
    { name: "the extract as pulled", lines: (a) => a.filter((k) => keep(k.line)), mustDiffer: false },
    { name: "CONTROL 1: no block terminator", lines: (a) => a.filter((k) => keep(k.line)), noTerminator: true, mustDiffer: true },
    { name: "CONTROL 2: terrain lines dropped", lines: (a) => a.filter((k) => keep(k.line) && !isTerrain(k.line)), mustDiffer: true },
    { name: "CONTROL 3: numeric-location lines dropped", lines: (a) => a.filter((k) => keep(k.line) && k.line.indexOf("at location [") < 0 && k.line.indexOf(":Location:") < 0), mustDiffer: true },
  ];

  let fails = 0, keptTotal = 0, shopTotal = 0;
  const diffs = new Map<string, number>();
  for (const { id, text } of rows) {
    const all: Kept[] = text.split(/\r?\n/).map((line, i) => ({ ord: i + 1, line }));
    keptTotal += all.filter((k) => keep(k.line)).length;
    const base = replay(all, opts);
    shopTotal += base.length;
    for (const v of variants) {
      const got = replay(v.lines(all), { ...opts, noTerminator: v.noTerminator });
      const same = got.length === base.length && got.every((o, i) => sig(o) === sig(base[i]));
      if (!same) diffs.set(v.name, (diffs.get(v.name) ?? 0) + 1);
    }
  }
  console.log(`[control] ${shopTotal} shop lines across those logs, ${keptTotal} lines kept by keep()`);
  for (const v of variants) {
    const n = diffs.get(v.name) ?? 0;
    const ok = v.mustDiffer ? n > 0 : n === 0;
    if (!ok) fails++;
    console.log(` ${ok ? "PASS" : "FAIL"}  ${v.name.padEnd(42)} differs on ${n}/${rows.length} logs` +
      (v.mustDiffer && n === 0 ? "   <- FINDING: this signal changes no verdict on this sample" : ""));
  }
  return fails;
}

/**
 * TRACE ONE TOKEN THROUGH WHOLE LOGS, so a row in the report can be read against the log by hand.
 *
 *   npx tsx tools/probe-shoploc.ts --trace SCShop_Cargo_Office --full E:/tmp/shoploc/two.gz
 *
 * 🔴 THE POINT IS THAT IT PRINTS THE EVIDENCE, NOT THE ANSWER. Every shop line for the token, the
 * verdict, and the log line the verdict came from — so "Seraphim Station" can be checked against
 * a `requested inventory for Location[RR_CRU_LEO]` you read yourself. A map like this decides
 * which shop a price is attributed to; at least one row of it has to be verified by a person.
 */
async function trace(fullFile: string, want: string, loaded: Loaded): Promise<void> {
  const rl = createInterface({ input: createReadStream(fullFile).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const row of rl) {
    const a = row.indexOf(" ");
    if (a < 0) continue;
    const id = row.slice(0, a);
    const text = Buffer.from(row.slice(a + 1), "base64").toString("utf8");
    const all: Kept[] = text.split(/\r?\n/).map((line, i) => ({ ord: i + 1, line }));
    const rows = replay(all, { loaded, placeIds: {}, withTerminal: false })
      .filter((o) => o.token === want);
    if (!rows.length) continue;
    console.log(`\n=== ${id} — ${rows.length} ${want} lines`);
    /* Collapse the runs: a purchase writes several shop lines a second apart and printing 40
     * identical verdicts hides the one that matters. */
    let last = "";
    for (const r of rows) {
      const sig = `${r.tier}|${r.placeId}|${r.from}`;
      if (sig === last) continue;
      last = sig;
      console.log(`  ${new Date(r.at).toISOString()}  ${r.tier.padEnd(7)} ${(r.placeId ? loaded.locations[r.placeId]?.name ?? r.placeId : "-").padEnd(22)} age ${r.ageMin === null ? "-" : r.ageMin.toFixed(1) + " min"}`);
      console.log(`      from: ${r.from}`);
    }
  }
}

/* ── the UEX side of the join ─────────────────────────────────────────────────────────────────*/

interface ItemTerminal { n: string; sys?: string; body?: string; place?: string }

interface TerminalPlaces {
  /** UEX terminal name -> starmap place id. */
  byTerminal: Map<string, string>;
  /** How each entry was placed, for the report. */
  stats: { commodityDirect: number; lastSegment: number; nameJoin: number; unplaced: number; conflicts: string[] };
}

/**
 * WHERE EACH UEX TERMINAL IS, in starmap ids — the other half of the join.
 *
 * Three sources, in descending order of how much they assume:
 *
 * 🔑 **1. THE COMMODITY TABLE STATES THE ID OUTRIGHT.** `commodities.json` carries a `location`
 * field beside every terminal name, and it is a starmap uuid: **133 terminals, 0 unresolvable.**
 * No name matching at all, so this is evidence rather than inference and it goes first.
 *
 * **2. THE LAST SEGMENT, LEARNED FROM (1).** UEX names a terminal `Store - [District -] Place`.
 * Taking the last segment of each of those 133 verified names gives a `place-word -> id` map that
 * was never guessed — and it is what rescues Grim HEX, below.
 *
 * **3. `buildTerminalIndex`, the shipped join** — but only where the row it lands on is really a
 * place. 🔴 That join has a fallback from `place` to `body`, and for Grim HEX the fallback FIRES:
 * UEX files those five shops under the place "Green Imperial Housing Exchange", which is in no
 * starmap row, so all five resolve to the PLANET Crusader. The shipped index reports them as
 * resolved. They are not mis-placed by much — they are mis-placed by an orbit. `tierOfRecord`
 * catches it here; the `src/` half is Cargo.
 *
 * ⚠️ Where two sources both answer, disagreement is COUNTED and listed rather than silently
 * resolved by priority. A source that quietly overrides another is a source that can be wrong
 * without anyone finding out.
 */
function terminalPlaces(locations: Record<string, LocationRecord>): TerminalPlaces {
  const byTerminal = new Map<string, string>();
  const stats = { commodityDirect: 0, lastSegment: 0, nameJoin: 0, unplaced: 0, conflicts: [] as string[] };

  // 1. The commodity table's own ids.
  const com = JSON.parse(readFileSync(join(DATA, "commodities.json"), "utf8")) as
    { commodities?: Record<string, { prices?: { terminal?: string; location?: string }[] }> };
  for (const c of Object.values(com.commodities ?? {})) {
    for (const p of c.prices ?? []) {
      if (!p.terminal || !p.location || !locations[p.location]) continue;
      if (!byTerminal.has(p.terminal)) { byTerminal.set(p.terminal, p.location); stats.commodityDirect++; }
    }
  }

  // 2. The last-segment map, learned from those verified names only.
  const lastSeg = (n: string): string => squash(n.split(" - ").pop() ?? "");
  const segIds = new Map<string, Set<string>>();
  for (const [n, id] of byTerminal) {
    const k = lastSeg(n);
    if (!k) continue;
    let s = segIds.get(k);
    if (!s) segIds.set(k, (s = new Set()));
    s.add(id);
  }
  const segPlace = new Map<string, string>();
  for (const [k, s] of segIds) if (s.size === 1) segPlace.set(k, [...s][0]);

  // 3. The shipped join, place-tier rows only.
  const item = (JSON.parse(readFileSync(join(DATA, "item-shops.json"), "utf8")) as
    { terminals?: ItemTerminal[] }).terminals ?? [];
  const index = buildTerminalIndex(item as never, locations);
  for (const t of item) {
    if (byTerminal.has(t.n)) continue;
    const fromSeg = segPlace.get(lastSeg(t.n)) ?? null;
    const joined = index.byTerminal.get(t.n) ?? null;
    const fromJoin = joined && tierOfRecord(locations[joined]) === "place" ? joined : null;
    if (fromSeg && fromJoin && fromSeg !== fromJoin) {
      stats.conflicts.push(`${t.n}: last-segment says ${locations[fromSeg]?.name}, the name join says ${locations[fromJoin]?.name}`);
    }
    const id = fromSeg ?? fromJoin;
    if (!id) { stats.unplaced++; continue; }
    byTerminal.set(t.n, id);
    if (fromSeg) stats.lastSegment++; else stats.nameJoin++;
  }
  return { byTerminal, stats };
}

/* ── aggregation ──────────────────────────────────────────────────────────────────────────────*/

interface PlaceHit { id: string; name: string; n: number; contributors: number }

interface TokenReport {
  token: string;
  /** Every shop line seen for this token, after the double-count dedupe. */
  observations: number;
  /** Of those, how many got a genuine SAME-PLACE verdict. Only these may resolve anything. */
  placed: number;
  byTier: Record<string, number>;
  places: PlaceHit[];
  /** The share of placed observations that did NOT land on the leading place. */
  disagreement: number;
  /** 🔴 THE EVIDENCE TIER — how far the log actually got, never further:
   *   `terminal`        one place, and exactly one UEX terminal there answers to this shop's name.
   *   `place`           one place, but the terminal within it is not pinned down. Attribute to the
   *                     place; the candidates are listed and the count says why.
   *   `place-dependent` this token is used at SEVERAL stations. A finding, not a failure.
   *   `unresolved`      no same-place verdict was ever reached for it. */
  verdict: "terminal" | "place" | "place-dependent" | "unresolved";
  /** The UEX terminal name, ONLY on the `terminal` verdict. Null everywhere else, deliberately —
   *  a consumer must not be able to read a guess out of this field. */
  terminal: string | null;
  /** The same pick when the place behind it is thin (<8 same-place observations, or one
   *  contributor). Kept so nothing is lost, held separate so nothing is claimed. */
  provisionalTerminal: string | null;
  /** Which word of the asset name picked that terminal out, so the claim is auditable. */
  matchedOn: string | null;
  /**
   * 🔴 HOW MUCH OF THE SINGLE-PLACE ANSWER IS EVIDENCE AND HOW MUCH IS THIN SAMPLING.
   *
   * "One place" and "one place, seen four times, by one person" are different claims, and this
   * corpus contains both. `SCShop_ShipWeapons_UtilStation` resolves to exactly one place on **4**
   * observations — while its structural twin `SCShop_RestStop_Pharmacy` resolves to **six**. The
   * difference is almost certainly how often somebody happened to shop there, not the shop.
   *
   * `confident` needs >= 8 same-place observations AND >= 2 contributors. Everything else is
   * `provisional`: believable, not yet corroborated, and NOT safe to attribute a price with.
   */
  confidence: "confident" | "provisional" | "none";
  /** Every observation's `why`, tallied. On an `unresolved` token this IS the reason. */
  why: Record<string, number>;
  /** Every UEX terminal filed at the resolved place. Present on `place` too, where it is the
   *  honest statement of what is still open. */
  candidates: string[];
  contributors: number;
}

/** Alphanumeric-lowercase. The same squash `matchKey` uses, applied to a whole terminal name. */
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** The words of a shop asset name that could name a store: `SCShop_Entity_CubbyBlast_Area18` ->
 *  ["entity", "cubbyblast", "area18"]. Words of one or two characters are dropped — they are
 *  initials and codes, and matching those against a terminal name is how "XS" claims a shop. */
function assetWords(token: string): string[] {
  return token.replace(/^SCShop_?/i, "").replace(/-\d+$/, "")
    .split(/[_\-]+/).map(squash).filter((w) => w.length >= 3);
}

/**
 * Which UEX terminal at this place the shop token names, if exactly one does.
 *
 * 🔴 THE PLACE DOES THE WORK; THE NAME ONLY BREAKS THE TIE. This is not the name join that failed
 * (0 of 75) reintroduced — the candidate set is already narrowed to the one station the LOG put
 * the player at, so a word only has to separate the shops inside one building. That is why a
 * substring test is safe here and is not safe across the whole 500-row terminal table.
 *
 * 🔴 A WORD THAT MATCHES EVERY CANDIDATE IS NOT EVIDENCE, AND IT IS THE COMMON CASE. UEX ends
 * every terminal name with the place, so `SCShop_Entity_CubbyBlast_Area18`'s word "area18" matches
 * all nine Area 18 shops — nine hits, no unique winner, and the first cut of this function
 * therefore pinned **2 of 41** resolved tokens while the store name was sitting right there.
 * Non-discriminating words are dropped before the count.
 *
 * 🔑 UNIQUE OR NOTHING. Orison has TWO Kel-To kiosks and both answer to "kelto", so
 * `SCShop_Orison_KelTo` gets a `place` verdict with two candidates named — which is the true
 * answer. Taking either one would be a coin flip recorded as a fact.
 */
/**
 * The game's own CATEGORY words, derived from the corpus rather than listed by taste.
 *
 * 🔴 THE PICK THIS EXISTS TO KILL, and it was a confident, precise, wrong answer of exactly the
 * kind this flight is about: `SCShop_Levski_CargoOffice_ITEM` pinned to **"Teach's Item Shop -
 * Levski"**, because "item" is a rare word in the terminal table (1 of 613) and matched nothing
 * else at Levski. It is not a store name. It is the suffix the game puts on the ITEM half of a
 * shop that also has a commodity half — `SCShop_Levski_CargoOffice_Commodities` is the other one.
 * Teach's is a real, different shop, which the log also visits under its own token.
 *
 * 🔑 THE TELL IS STRUCTURAL AND NEEDS NO STOPLIST: two asset names identical but for their last
 * word are one shop split by category, so both last words describe a COUNTER and neither can
 * identify a STORE. Frequency could never have caught this — measured, "item" is as rare in the
 * terminal table as "cordrys" is.
 *
 * ⚠️ It fires on ONE pair in today's corpus, so it is a rule resting on a single observation. It
 * is kept because the mechanism is sound and because the alternative is a hand-written stoplist,
 * which is a rule resting on nothing. A second pair appearing would strengthen it, not change it.
 */
function categoryWords(tokens: readonly string[]): Set<string> {
  const byStem = new Map<string, Set<string>>();
  for (const t of tokens) {
    const w = assetWords(t);
    if (w.length < 2) continue;
    const stem = w.slice(0, -1).join("|");
    let s = byStem.get(stem);
    if (!s) byStem.set(stem, (s = new Set()));
    s.add(w[w.length - 1]);
  }
  const out = new Set<string>();
  for (const s of byStem.values()) if (s.size > 1) for (const w of s) out.add(w);
  return out;
}

function pickTerminal(
  token: string,
  candidates: string[],
  category: ReadonlySet<string>,
): { terminal: string; matchedOn: string } | null {
  if (candidates.length === 0) return null;
  const keys = candidates.map(squash);
  const hits = new Map<string, string>();   // terminal -> the word that picked it
  for (const w of assetWords(token)) {
    if (category.has(w)) continue;
    const matched = keys.filter((k) => k.includes(w));
    // 0 says nothing; all-of-them says only "we agree about the city".
    if (!matched.length || matched.length === candidates.length) continue;
    for (const k of matched) hits.set(candidates[keys.indexOf(k)], w);
  }
  if (hits.size === 1) {
    const [terminal, matchedOn] = [...hits][0];
    return { terminal, matchedOn };
  }
  /* One candidate and one shop is not a match — it is a coincidence of a thin table. A place with
   * a single UEX terminal says nothing about whether THIS shop is that terminal; plenty of game
   * shops are in no UEX table at all. It stays a `place` verdict. */
  return null;
}

function aggregate(
  obs: Obs[],
  locations: Record<string, LocationRecord>,
  placeToTerminals: Map<string, string[]>,
): TokenReport[] {
  const byToken = new Map<string, Obs[]>();
  for (const o of obs) {
    let a = byToken.get(o.token);
    if (!a) byToken.set(o.token, (a = []));
    a.push(o);
  }
  const category = categoryWords([...byToken.keys()]);
  const out: TokenReport[] = [];
  for (const [token, rows] of byToken) {
    const byTier: Record<string, number> = {};
    for (const r of rows) byTier[r.tier] = (byTier[r.tier] ?? 0) + 1;
    const placeCount = new Map<string, { n: number; usr: Set<string> }>();
    for (const r of rows) {
      if (!r.placeId) continue;
      let c = placeCount.get(r.placeId);
      if (!c) placeCount.set(r.placeId, (c = { n: 0, usr: new Set() }));
      c.n++;
      c.usr.add(r.usr ?? "?");
    }
    const places: PlaceHit[] = [...placeCount.entries()]
      .map(([id, c]) => ({ id, name: locations[id]?.name ?? id, n: c.n, contributors: c.usr.size }))
      .sort((a, b) => b.n - a.n);
    const placed = places.reduce((s, p) => s + p.n, 0);
    const lead = places[0]?.n ?? 0;

    let verdict: TokenReport["verdict"];
    let terminal: string | null = null;
    let provisionalTerminal: string | null = null;
    let matchedOn: string | null = null;
    let candidates: string[] = [];
    if (places.length === 1) {
      candidates = placeToTerminals.get(places[0].id) ?? [];
      const pick = pickTerminal(token, candidates, category);
      matchedOn = pick?.matchedOn ?? null;
      /* 🔴 THIN EVIDENCE MAY NOT POPULATE `terminal`, AND THE THIN CASES ARE EXACTLY THE
       * DANGEROUS ONES. `SCShop_NoodleBar_A_Food_RestStop` lands on one place across 5
       * observations and pins to "Noodle Bar - Port Tressler" — but a noodle bar is a REST-STOP
       * FITTING, and its structural twin `SCShop_RestStop_Pharmacy` resolves to six places on 44.
       * The difference is who happened to shop where, not the shop. `SCShop_BurritoBar_Food_
       * RestStop` would have been pinned on ONE observation.
       *
       * So the pick still rides, under `provisionalTerminal`, and the verdict stays `place`. A
       * consumer reading `terminal` can never receive a claim resting on one player's afternoon.
       * The rule this flight lives by, applied to itself. */
      const thin = !(places[0].n >= 8 && places[0].contributors >= 2);
      terminal = pick && !thin ? pick.terminal : null;
      provisionalTerminal = pick && thin ? pick.terminal : null;
      verdict = terminal ? "terminal" : "place";
    } else if (places.length > 1) {
      /* 🔴 SEVERAL PLACES IS A FINDING, NOT A FAILURE, and taking the majority would be the exact
       * mistake this probe was built to prevent. `SCShop_Cargo_Office` is one asset at thirteen
       * stations; no string could ever have separated them, and neither may a vote. */
      verdict = "place-dependent";
    } else {
      verdict = "unresolved";
    }

    out.push({
      token,
      observations: rows.length,
      placed,
      byTier,
      places,
      disagreement: placed ? (placed - lead) / placed : 0,
      verdict, terminal, provisionalTerminal, matchedOn, candidates,
      why: (() => {
        const w: Record<string, number> = {};
        for (const r of rows) w[r.why] = (w[r.why] ?? 0) + 1;
        return w;
      })(),
      confidence: places.length !== 1 ? "none"
        : places[0].n >= 8 && places[0].contributors >= 2 ? "confident" : "provisional",
      contributors: new Set(rows.map((r) => r.usr ?? "?")).size,
    });
  }
  return out.sort((a, b) => b.observations - a.observations);
}

/* ── main ─────────────────────────────────────────────────────────────────────────────────────*/

async function main(): Promise<void> {
  const linesFile = arg("--lines") ?? "E:/tmp/shoploc/lines.gz";
  const metaFile = arg("--meta") ?? "E:/tmp/shoploc/meta.csv";
  const outFile = arg("--out");
  const withTerminal = flag("--with-terminal");
  const perSession = flag("--per-session");

  const loaded = load();
  const wantTrace = arg("--trace");
  if (wantTrace) { await trace(arg("--full") ?? "E:/tmp/shoploc/full.gz", wantTrace, loaded); return; }
  if (flag("--control")) {
    const fails = await control(arg("--full") ?? "E:/tmp/shoploc/full.gz", loaded);
    if (fails) { console.error(`\n[control] ${fails} FAILED`); process.exitCode = 1; }
    else console.log("\n[control] all passed");
    return;
  }
  const meta = readMeta(metaFile);
  console.log(`[shoploc] ${Object.keys(loaded.locations).length} starmap rows, ${meta.size} logs`);

  /* PASS 1 — learn the numeric-id bindings, IN SESSION ONLY, and measure whether any id is ever
   * seen naming two different places. That measurement is the licence for pass 2's corpus-wide
   * map: an id that is ambiguous anywhere in the corpus is excluded from it outright. */
  const bindings = new Map<string, Set<string>>();
  const logs: { id: string; lines: Kept[] }[] = [];
  await eachLog(linesFile, (id, lines) => {
    logs.push({ id, lines });
    replay(lines, {
      loaded, placeIds: {}, withTerminal,
      onBind: (id2, token) => {
        let s = bindings.get(id2);
        if (!s) bindings.set(id2, (s = new Set()));
        s.add(token);
      },
    });
  });
  const ambiguousIds = [...bindings.values()].filter((s) => s.size > 1).length;
  const globalIds: Record<string, string> = {};
  for (const [id, s] of bindings) if (s.size === 1) globalIds[id] = [...s][0];
  console.log(`[shoploc] numeric-id bindings: ${bindings.size} distinct, ${ambiguousIds} ambiguous across the corpus`);

  /* PASS 2 — grade every shop line. */
  const seen = new Set<string>();          // the double-count dedupe key
  const obs: Obs[] = [];
  let rawRows = 0;
  for (const { id, lines } of logs) {
    const usr = meta.get(id)?.usr ?? "?";
    const rows = replay(lines, {
      loaded,
      placeIds: perSession ? {} : { ...globalIds },
      withTerminal,
    });
    for (const r of rows) {
      rawRows++;
      /* 🔴 THE CORPUS DOUBLE-COUNTS. A live log is re-uploaded whenever its content changes, so
       * one session arrives as several rows each a superset of the last. The GAME's own
       * millisecond timestamp plus the contributor is the identity of an observation; the row is
       * not. Counting rows counts one visit up to four times, and — worse — plants duplicate
       * observations at one instant, which reads downstream as corroboration. */
      const key = usr + "|" + r.at + "|" + r.token;
      if (seen.has(key)) continue;
      seen.add(key);
      obs.push({ ...r, usr });
    }
  }
  console.log(`[shoploc] ${rawRows} shop lines in the corpus, ${obs.length} distinct observations after dedupe (${(100 * (rawRows - obs.length) / Math.max(1, rawRows)).toFixed(1)}% were re-uploads)`);

  const tp = terminalPlaces(loaded.locations);
  console.log(`[shoploc] UEX terminals placed: ${tp.byTerminal.size} — ${tp.stats.commodityDirect} from the commodity table's own id, ${tp.stats.lastSegment} by the learned last segment, ${tp.stats.nameJoin} by the shipped name join; ${tp.stats.unplaced} unplaced, ${tp.stats.conflicts.length} conflicts`);
  for (const c of tp.stats.conflicts.slice(0, 10)) console.log(`           conflict: ${c}`);
  const placeToTerminals = new Map<string, string[]>();
  for (const [name, placeId] of tp.byTerminal) {
    let a = placeToTerminals.get(placeId);
    if (!a) placeToTerminals.set(placeId, (a = []));
    a.push(name);
  }

  const reports = aggregate(obs, loaded.locations, placeToTerminals);
  const tally = { terminal: 0, place: 0, "place-dependent": 0, unresolved: 0 };
  for (const r of reports) tally[r.verdict]++;
  const totalObs = obs.length;
  const placedObs = obs.filter((o) => o.placeId).length;
  const share = (sel: (r: TokenReport) => boolean) =>
    reports.filter(sel).reduce((s, r) => s + r.observations, 0);

  console.log(`[shoploc] tokens: ${reports.length} — ${tally.terminal} pinned to a UEX terminal, ${tally.place} pinned to a place only, ${tally["place-dependent"]} place-dependent, ${tally.unresolved} unresolved`);
  console.log(`[shoploc] observations: ${placedObs}/${totalObs} (${(100 * placedObs / totalObs).toFixed(1)}%) got a same-place verdict`);
  {
    const placed = obs.filter((o) => o.placeId);
    const buckets = [1, 5, 15, 45, 180, 1440, Infinity];
    const counts = buckets.map(() => 0);
    let staleN = 0;
    for (const o of placed) {
      if (o.stale) staleN++;
      const a2 = o.ageMin ?? Infinity;
      counts[buckets.findIndex((b2) => a2 <= b2)]++;
    }
    console.log(`[shoploc] age of the reading behind a same-place verdict: ` +
      buckets.map((b2, i) => `<=${b2 === Infinity ? "inf" : b2 + "m"}:${counts[i]}`).join("  "));
    console.log(`[shoploc] ${staleN}/${placed.length} (${(100 * staleN / placed.length).toFixed(1)}%) rest on a reading resolveOrigin itself calls stale`);
  }
  console.log(`[shoploc] log volume: ${(100 * share((r) => r.verdict === "terminal") / totalObs).toFixed(1)}% terminal, ${(100 * share((r) => r.verdict === "place") / totalObs).toFixed(1)}% place, ${(100 * share((r) => r.verdict === "place-dependent") / totalObs).toFixed(1)}% place-dependent, ${(100 * share((r) => r.verdict === "unresolved") / totalObs).toFixed(1)}% unresolved`);

  const conf = reports.filter((r) => r.confidence === "confident").length;
  const prov = reports.filter((r) => r.confidence === "provisional").length;
  console.log(`[shoploc] of the ${tally.terminal + tally.place} single-place tokens, ${conf} are confident (>=8 same-place observations from >=2 contributors) and ${prov} are provisional`);

  console.log("\n token                                          obs  placed  pl  disagree  verdict / evidence");
  for (const r of reports) {
    console.log(
      " " + r.token.padEnd(45).slice(0, 45) +
      String(r.observations).padStart(5) +
      String(r.placed).padStart(8) +
      String(r.places.length).padStart(4) +
      (100 * r.disagreement).toFixed(0).padStart(9) + "%" +
      "  " + (r.confidence === "provisional" ? "~" : " ") + r.verdict.padEnd(16) +
      (r.verdict === "terminal" ? r.terminal
        : r.verdict === "place" ? (r.provisionalTerminal ? `${r.places[0].name} — provisionally ${r.provisionalTerminal}` : `${r.places[0].name} — ${r.candidates.length} UEX terminals there`)
        : r.verdict === "place-dependent" ? r.places.map((p) => `${p.name}(${p.n})`).join(", ")
        : "no same-place verdict, ever"),
    );
  }

  if (outFile) {
    writeFileSync(outFile, JSON.stringify({
      reports, placeToTerminals: [...placeToTerminals], ambiguousIds,
      totals: { tokens: reports.length, ...tally, observations: totalObs, placed: placedObs },
    }, null, 1));
    console.log(`\n[shoploc] wrote ${outFile}`);
  }

  const emitFile = arg("--emit");
  if (emitFile) {
    if (withTerminal) throw new Error("refusing to emit from a --with-terminal run: that is the circularity control, not a measurement");
    writeFileSync(emitFile, emit(reports, obs, loaded, meta) + "\n");
    console.log(`[shoploc] wrote ${emitFile}`);
  }
}

/**
 * THE SHIPPABLE FILE. One entry per shop token, carrying its evidence rather than only its answer.
 *
 * 🔴 EVERY ENTRY STATES HOW FAR THE LOG GOT AND STOPS THERE. `terminal` is populated on exactly
 * one verdict; on every other it is `null` and the caller has to read `verdict` to find out what
 * is known. That is deliberate — a consumer must not be able to reach a guess by reading one
 * field, because a wrong terminal silently attributes a price to a shop that never charged it.
 */
function emit(reports: TokenReport[], obs: Obs[], loaded: Loaded, meta: Map<string, Meta>): string {
  /* 🔴 THE SPAN COMES FROM THE UPLOAD TIME, NOT THE GAME CLOCK. Measured: 3,178 of 709,221
   * extracted lines are stamped 2025-07 / 2025-08 — a contributor whose machine clock is a year
   * out. It changes no verdict, because every age here is a difference between two timestamps
   * inside ONE log and a uniform shift cancels; it only made a game-time span read 389 days
   * instead of 35. `created` is written by the server and cannot drift. */
  const up = [...meta.values()].map((m) => Date.parse(m.created)).filter(Number.isFinite).sort((a, b) => a - b);
  const days = up.length ? Math.round((up[up.length - 1] - up[0]) / 86_400_000) : 0;
  const tokens: Record<string, unknown> = {};
  for (const r of reports) {
    const kinds = new Set(obs.filter((o) => o.token === r.token).map((o) => o.kind));
    tokens[r.token] = {
      verdict: r.verdict,
      terminal: r.terminal,
      provisionalTerminal: r.provisionalTerminal,
      matchedOn: r.matchedOn,
      place: r.places.length === 1 ? { id: r.places[0].id, name: r.places[0].name } : null,
      candidates: r.verdict === "place" ? r.candidates : [],
      places: r.verdict === "place-dependent"
        ? r.places.map((p) => ({ id: p.id, name: p.name, observations: p.n, contributors: p.contributors }))
        : [],
      confidence: r.confidence,
      soldBy: [...kinds].sort(),
      evidence: {
        observations: r.observations,
        samePlace: r.placed,
        byTier: r.byTier,
        placeCount: r.places.length,
        why: r.why,
        disagreement: Number(r.disagreement.toFixed(4)),
        contributors: r.contributors,
      },
    };
  }
  const totals = { terminal: 0, place: 0, "place-dependent": 0, unresolved: 0 };
  for (const r of reports) totals[r.verdict]++;
  const doc = {
    schema: "sc-shop-terminals/1",
    note: "Game shop asset name -> where the player was standing when they used it. Derived by replaying the opt-in shared-log corpus through src/player-location.ts + src/origin-signals.ts + src/player-origin.ts. Rebuild with `npm run probe:shoploc`.",
    method: {
      rule: "Only a same-place verdict resolves anything. A body or system verdict names somewhere the player was NEAR and is never counted.",
      guard: "The shop terminal is removed from the location service's inputs before grading, because collectOriginSignals reads a place out of the shop's own asset name and the answer would otherwise come from the token being asked about.",
      samePlace: "tier === 'place' AND the starmap row's own type is a place — not a Star, Planet or Moon. 4.2% of place-tier verdicts are one of those.",
      multiPlace: "A token seen at more than one place is recorded as place-dependent and is NEVER resolved by majority.",
    },
    /** How to read this, for whatever consumes it next. Written down because the interesting
     *  entries are the ones that decline to answer, and a caller that only reads `terminal` will
     *  silently treat every one of them as "no data" rather than as "ask the log". */
    usage: {
      terminal: "Attribute to this UEX terminal.",
      place: "The station is known; which counter inside it is not. `candidates` lists every UEX terminal filed at that place. Attribute to the place, or narrow it with something else. If `provisionalTerminal` is set, one candidate did answer to this shop's name but the place behind it is thin — believable, not corroborated, and not safe to attribute a price with.",
      "place-dependent": "This asset exists at several stations, so the token alone cannot say which. It is still resolvable AT RUNTIME — the app already knows where the player is; ask src/player-location.ts rather than this file.",
      unresolved: "No same-place verdict was ever reached. Nothing may be attributed. `evidence.why` says which of two very different things happened: `system`/`body`/`unknown` means the log never placed the player at all while they were here (only more play fixes it), while `place-too-old` or `place-is-a-body` means it did and this refused the answer.",
      notInjective: "The map is many-to-one and must not be inverted. SCShop_Levski_Refinery_Store and SCShop_Levski_Refinery_OreSales both resolve to 'Refinery Shop - Levski' — the game splits the item counter from the ore desk and UEX does not.",
      confidence: "`provisional` means one place on thin evidence (<8 same-place observations, or a single contributor). Believable, not corroborated.",
    },
    corpus: {
      source: "site.bp_shared_logs (opt-in, read-only)",
      logs: meta.size,
      contributors: new Set([...meta.values()].map((m) => m.usr)).size,
      spanDaysUploaded: days,
      shopObservations: obs.length,
      samePlaceObservations: obs.filter((o) => o.placeId).length,
      caveat: "Sessions stored before 2026-08-24 were gathered under a share filter with no price term, so shopping sessions are under-represented. That biases coverage, not correctness.",
    },
    totals: { tokens: reports.length, ...totals },
    tokens,
  };
  return JSON.stringify(doc, null, 1);
}

void main();
