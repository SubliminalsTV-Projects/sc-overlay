/**
 * THE SIGNAL COLLECTOR, ON THE REAL STARMAP.  `npm run test:signals`
 *
 * Driven against `data/locations.json` as shipped, because every claim here is about whether a
 * real token lands on a real place. A fixture starmap would let all of it stay green while the
 * shipped data stopped supporting it.
 *
 * 🔑 The end-to-end assertions run the collector's output through the REAL `resolveOrigin`, since
 * a signal that grades wrongly is no better than one that never fired.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectOriginSignals, originDepsFor } from "./origin-signals.js";
import { resolveOrigin } from "./player-origin.js";
import { matchKey, systemKey, type LocationRecord } from "./verse-proximity.js";

const DATA = join(process.cwd(), "data");
let pass = 0, fail = 0;
const ok = (c: boolean, name: string, detail = "") => {
  if (c) { pass++; console.log(`ok    ${name}${detail ? "  [" + detail + "]" : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  [" + detail + "]" : ""}`); }
};

const locations = (JSON.parse(readFileSync(join(DATA, "locations.json"), "utf8")) as
  { locations: Record<string, LocationRecord & { type?: string }> }).locations;

const idOf = (name: string, sys: string): string => {
  const hits = Object.entries(locations).filter(
    ([, v]) => matchKey(v.name) === matchKey(name) && systemKey(v.system) === sys);
  if (hits.length !== 1) throw new Error(`fixture ${name}@${sys} matched ${hits.length}`);
  return hits[0][0];
};

const AREA18 = idOf("Area18", "stanton");
const DAYMAR = idOf("Daymar", "stanton");
const NOW = 1_800_000_000_000;
const deps = { locations, now: () => NOW };

// ── The three place sources ───────────────────────────────────────────────────────────────────
{
  const sig = collectOriginSignals(
    { atLocation: { token: "Area18", at: NOW - 60_000 }, system: "stanton" }, deps);
  const place = sig.find((s) => s.tier === "place");
  ok(!!place, "an ASOP token that IS a place name resolves", place?.label ?? "none");
  ok(place?.id === AREA18, "...to the right starmap id");
  ok(place?.at === NOW - 60_000, "...carrying the LOG's time, not now", String(place?.at));
  ok(/ASOP/i.test(place?.source ?? ""), "...and says which signal it came from", place?.source);
}
{
  const sig = collectOriginSignals(
    { cargoMove: { direction: "down", platform: "Lorville", at: NOW - 120_000 }, system: "stanton" },
    deps);
  ok(sig.some((s) => s.tier === "place" && /freight/i.test(s.source)),
     "a freight elevator produces a place signal",
     sig.find((s) => s.tier === "place")?.label ?? "none");
}

// ── 🔴 AN UNRESOLVABLE TOKEN PRODUCES NOTHING, not a guess ────────────────────────────────────
// 🔑 Paired with a POSITIVE assertion first: "no place signal" is satisfied for free by a
// collector that emits nothing at all, and a broken collector is exactly what emits nothing.
{
  const good = collectOriginSignals({ atLocation: { token: "Area18", at: NOW }, system: "stanton" }, deps);
  ok(good.some((s) => s.tier === "place"), "the collector CAN emit a place signal", `${good.length} signals`);

  const bad = collectOriginSignals(
    { atLocation: { token: "ZZ_NotAPlace_9999", at: NOW }, system: "stanton" }, deps);
  ok(!bad.some((s) => s.tier === "place"), "...but an unplaceable token emits no place signal",
     bad.map((s) => s.tier).join(",") || "none");
  ok(bad.some((s) => s.tier === "system"), "...while the system reading still stands",
     bad.find((s) => s.tier === "system")?.label ?? "none");
}

// ── The injected resolver is preferred, and its null is respected ─────────────────────────────
{
  const sig = collectOriginSignals(
    { atLocation: { token: "RR_ARC_LEO", at: NOW }, system: "stanton" },
    { ...deps, resolveToken: (t) => (t === "RR_ARC_LEO" ? AREA18 : null) });
  ok(sig.some((s) => s.tier === "place" && s.id === AREA18),
     "an injected resolver places a token the name match cannot");

  // 🔑 A resolver returning null must not silently fall through to a WRONG name match. Here the
  // token IS a real place name, so the fallback would resolve it — the assertion is that a
  // resolver saying "no" about a token it does not recognise still lets the name path work,
  // which is the documented contract (resolver first, name second).
  const sig2 = collectOriginSignals(
    { atLocation: { token: "Area18", at: NOW }, system: "stanton" },
    { ...deps, resolveToken: () => null });
  ok(sig2.some((s) => s.tier === "place" && s.id === AREA18),
     "...and a resolver that declines falls back to the name match");
}

// ── The terrain report is a BODY, and 'space' is not a position ───────────────────────────────
{
  const sig = collectOriginSignals(
    { place: { kind: "planet", body: "OOC_Stanton_2b_Daymar", name: "Daymar", at: NOW - 300_000 },
      system: "stanton" }, deps);
  const body = sig.find((s) => s.tier === "body");
  ok(!!body && body.id === DAYMAR, "a terrain report produces a BODY signal", body?.label ?? "none");
  ok(body?.at === NOW - 300_000, "...at the report's own time");

  const inSpace = collectOriginSignals({ place: { kind: "space", at: NOW }, system: "stanton" }, deps);
  ok(!inSpace.some((s) => s.tier === "body"),
     "...and 'space' produces no body signal, because it is not a position",
     inSpace.map((s) => s.tier).join(",") || "none");
}

// ── The system anchor is the STAR, which has coordinates ──────────────────────────────────────
{
  const sig = collectOriginSignals({ system: "pyro" }, deps);
  const s = sig.find((x) => x.tier === "system");
  ok(!!s, "a known system produces a system signal", s?.label ?? "none");
  ok(!!s && (locations[s.id] as { type?: string })?.type === "Star",
     "...anchored on the Star, not the SolarSystem row",
     (locations[s!.id] as { type?: string })?.type ?? "?");
  ok(!!s && !locations[s.id]?.parent, "...which is the root of that system");
  ok(systemKey(locations[sig.find((x) => x.tier === "system")!.id]?.system) === "pyro",
     "...and is in the right system");

  ok(!collectOriginSignals({ system: null }, deps).length,
     "no system and nothing else yields no signals at all");
}

// ── The numeric location id, once PlayerLocation has resolved it ──────────────────────────────
//
// 🔴 THE POSITIVE ASSERTION COMES FIRST, deliberately. The bug being guarded against is a signal
// that is silently DROPPED, and every "it is not wrong" check is satisfied for free by an empty
// list — which is exactly what the bug produces.
{
  const raw = collectOriginSignals(
    { atLocationId: { id: "3490636373", at: NOW - 60_000 }, system: "stanton" }, deps);
  ok(!raw.some((s) => s.tier === "place"),
     "a RAW numeric id still produces no place — a number names nothing",
     `${raw.filter((s) => s.tier === "place").length} place signals`);

  const bound = collectOriginSignals({
    atLocationId: { id: "3490636373", at: NOW - 60_000 },
    boundPlace: { token: "Area18", at: NOW - 60_000 },
    system: "stanton",
  }, deps);
  const p = bound.find((s) => s.tier === "place");
  ok(!!p, "...and the same id, BOUND, does produce one", p?.label ?? "none");
  ok(p?.id === AREA18, "...on the right starmap id", p?.id ?? "none");
  ok(p?.at === NOW - 60_000, "...stamped when the id was seen, not when we resolved it");
}

// ── A shop terminal: the bound path, the independent path, and the refusals ───────────────────
{
  const term = (over: Record<string, unknown>) => ({
    at: NOW - 30_000, shopName: "SCShop_Levski_CargoOffice_Commodities",
    kioskId: "776283668769", label: "Levski Cargo Office Commodities", boundToken: null, ...over,
  });
  const LEVSKI = idOf("Levski", "nyx");

  // 1. BOUND — what a location line named while the player stood here. Precise and certain.
  {
    const s = collectOriginSignals({ terminal: term({ boundToken: "Area18" }), system: "stanton" }, deps);
    const p = s.find((x) => x.tier === "place");
    ok(p?.id === AREA18, "a terminal bound to a place this session grades as that PLACE", p?.label ?? "none");
    ok(p?.detail === "Levski Cargo Office Commodities",
       "...and carries WHICH terminal as detail, not as a place", p?.detail ?? "none");
    ok(!s.some((x) => x.id === LEVSKI),
       "...and the shop's own name does NOT also fire — the observation outranks the label");
  }

  // 2. INDEPENDENT — the shop's own name against the starmap. The insurance path: this is the one
  //    that still works if CIG stops writing the location line the bound path learns from.
  {
    const s = collectOriginSignals({ terminal: term({}), system: "nyx" }, deps);
    const p = s.find((x) => x.tier === "place");
    ok(p?.id === LEVSKI, "an UNBOUND terminal resolves through its own name", p?.label ?? "none");
    ok(p?.source.indexOf("names this place") >= 0, "...and says that is where it came from", p?.source);
  }

  // 3. 🔴 A STAR IS NOT A PLACE. Five shop names in the corpus contain "Pyro", which is a Star row.
  {
    const s = collectOriginSignals(
      { terminal: term({ shopName: "SCShop_Pyro_RestStop_Rund_Admin", label: "Pyro Rest Stop Rund Admin" }) },
      deps);
    const anyPlace = s.filter((x) => x.tier === "place");
    ok(anyPlace.length === 0, "a shop name whose only match is a STAR reports no place",
       anyPlace.map((x) => x.label).join(",") || "none");
    const sys = s.find((x) => x.tier === "system");
    ok(!!sys, "...it reports a SYSTEM, which is all the name ever said", sys?.label ?? "none");
    ok(sys?.label === "Pyro", "...and names the right one", sys?.label ?? "none");
  }

  // 4. 🔴 THE MEASURED TRAP. This exact name sits at three different Keeger asteroid bases — two of
  //    them inside ONE session of Sub's — and it is what killed the persisted map.
  //    ⚠️ TWO mechanisms stop it and only one is obvious. It is the FOUR-CHARACTER GUARD that
  //    does the work: "Nyx" is three characters and is never looked up. Lowering that guard would
  //    still not produce a place, because "Nyx" is a `Star` and `tierOfRecord` caps it at a system.
  //    So the assertion is written as "no PLACE" rather than "no signal": the second is true today
  //    and is true for a reason that could change without the rule being broken.
  {
    const s = collectOriginSignals(
      { terminal: term({ shopName: "SCShop_AdminOffice_Nyx_SocialStation", label: "Admin Office Nyx Social Station" }) },
      deps);
    ok(!s.some((x) => x.tier === "place"),
       "the name that sits at three Keeger bases claims no place",
       s.map((x) => x.tier + ":" + x.label).join(",") || "none");
  }

  // 5. The other measured offender: a generic desk name at 13 stations, carrying no token at all.
  {
    const s = collectOriginSignals({ terminal: term({ shopName: "SCShop_Cargo_Office", label: "Cargo Office" }) }, deps);
    ok(s.length === 0, "a generic desk name claims nothing whatsoever",
       s.map((x) => x.tier + ":" + x.label).join(",") || "none");
  }

  // 6. 🔴 TWO RESOLVING WORDS IS NOT AN IDENTIFICATION — and the fixture is SYNTHETIC on purpose.
  //    No shipped shop name resolves ambiguously (0 of 61, measured), so an assertion driven by a
  //    real name could never fail and would read as the most on-point test in the file. This one
  //    puts two real, singly-resolving place names in one string, which is the only way to make
  //    the rule expressible at all. The positive control below is what proves it is not free.
  {
    const both = collectOriginSignals(
      { terminal: term({ shopName: "SCShop_Levski_Orison_Depot", label: "Levski Orison Depot" }) }, deps);
    ok(!both.length, "a name matching TWO places identifies neither",
       both.map((x) => x.tier + ":" + x.label).join(",") || "none");
    // Positive control, in the suite rather than by hand: each half alone DOES resolve, so the
    // refusal above is the ambiguity rule and not the two words being unknown.
    const one = collectOriginSignals({ terminal: term({ shopName: "SCShop_Levski_Depot" }) }, deps);
    ok(one.some((x) => x.id === LEVSKI), "...and the same name with one of them resolves fine",
       one.map((x) => x.label).join(",") || "none");
  }

  // 7. 🔴 A WORD SHARED BY MANY ROWS CONTRIBUTES NOTHING — it must not be resolved to whichever one
  //    got indexed first. This is a separate rule from #6 and needed its own control: relaxing the
  //    PER-WORD test leaves #6 green, because there the two words each name one row and the
  //    whole-name test still catches them. Only a word that is itself shared can tell them apart.
  //    ⚠️ The subject really is in the shipped starmap — the name `<= PLACEHOLDER =>` is on 12 rows
  //    and `<= UNINITIALIZED =>` on 20 — so this is not a must-not assertion about something absent.
  {
    const dupKey = Object.values(locations).filter((r) => matchKey(r.name) === "placeholder").length;
    ok(dupKey > 1, "the fixture word really is shared by several starmap rows", `${dupKey} rows`);
    const s = collectOriginSignals({ terminal: term({ shopName: "SCShop_Placeholder_Trader" }) }, deps);
    ok(!s.length, "a word shared by many rows resolves to none of them",
       s.map((x) => x.tier + ":" + x.label).join(",") || "none");
  }
}

// ── End to end, through the real resolveOrigin ────────────────────────────────────────────────
{
  // 🔑 The deps come from `originDepsFor`, NOT hand-rolled here. A hand-rolled `systemOf`
  // returning "stanton" while the system SIGNAL carries a starmap uuid is precisely the mismatch
  // that made a fresh Area18 fix grade as "somewhere in Stanton" — see originDepsFor's comment.
  const graded = (inputs: Parameters<typeof collectOriginSignals>[0]) =>
    resolveOrigin(collectOriginSignals(inputs, deps),
                  { ...originDepsFor(locations), now: () => NOW });

  const fresh = graded({ atLocation: { token: "Area18", at: NOW - 60_000 }, system: "stanton" });
  ok(fresh.tier === "place", "a fresh ASOP fix grades as a PLACE", fresh.tier);
  ok(fresh.id === AREA18, "...carrying the id the ordering needs");
  ok(!fresh.stale, "...and is not stale");

  // Past the 45-minute place window, so the place reading ages out and the system survives.
  const old = graded({ atLocation: { token: "Area18", at: NOW - 3 * 3_600_000 }, system: "stanton" });
  ok(old.stale || old.tier !== "place",
     "a three-hour-old fix is no longer asserted as a current place", `${old.tier}/stale=${old.stale}`);

  const nothing = graded({});
  ok(nothing.tier === "unknown", "with no signals at all the verdict is UNKNOWN", nothing.tier);
  ok(nothing.id === null, "...and carries no id for anything to compute from");
}

console.log(`\n${fail ? `FAILED (${fail})` : "all passed"}  ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
