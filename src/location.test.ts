// Place detection from the log's terrain-streaming report — `npm run test:location`.
import { PlaceWatcher, debrisStepWording, PLACE_STALE_MS, type Place } from "./location.js";

let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, got?: unknown) => {
  if (cond) { pass++; console.log(`  ok   ${label}`); }
  else { fail++; console.log(`  FAIL ${label}${got !== undefined ? `   [${JSON.stringify(got)}]` : ""}`); }
};

const NAMES = { pyro2: "Monox", pyro6: "Terminus", stanton2a: "Cellin" };
const cells = (n: number, body: string) =>
  `<2026-08-10T16:47:36.296Z>   planet cells:  ${n} [16384] meshes:   0 [ 2048] name: ${body}`;
const other = "<2026-08-10T16:47:36.296Z>   instances:  5 size: 688 bytes type: COrderedMesh";

console.log("\nreading a terrain block");
{
  const w = new PlaceWatcher(NAMES);
  w.push(cells(0, "pyro1")); w.push(cells(137, "pyro2")); w.push(cells(0, "pyro3"));
  ok("mid-block the place is still unknown — the report isn't complete", w.current().kind === "unknown");
  const changed = w.push(other);
  ok("the block ending is what commits the reading", changed);
  const p = w.current();
  ok("...and it resolves the body", p.kind === "planet" && p.body === "pyro2", p);
  ok("...to what the player calls it", p.kind === "planet" && p.name === "Monox", p);
}

console.log("\nthe millisecond-straddle trap");
{
  // A real block spans a ms boundary; the timestamp is NOT the block key. Grouping by
  // timestamp split one report in two and invented a deep-space reading at the seam.
  const w = new PlaceWatcher(NAMES);
  w.push(cells(0, "pyro1"));
  w.push(cells(27, "pyro2"));
  w.push("<2026-08-10T16:37:36.284Z>   planet cells:    0 [    0] meshes: 0 [ 0] name: OOC_Stanton_2_Crusader");
  w.push(other);
  const p = w.current();
  ok("a block crossing a millisecond is still ONE block", p.kind === "planet" && p.body === "pyro2", p);
}

console.log("\ndeep space, and leaving a planet");
{
  const w = new PlaceWatcher(NAMES);
  w.push(cells(0, "pyro1")); w.push(cells(0, "pyro2")); w.push(other);
  ok("a complete block with nothing streaming is space", w.current().kind === "space");
  w.push(cells(88, "pyro6")); w.push(other);
  ok("arriving at a body is picked up", w.current().kind === "planet");
  w.push(cells(0, "pyro6")); w.push(other);
  ok("LEAVING is picked up too — the next report reads all-zero", w.current().kind === "space");
}

console.log("\nname resolution");
{
  const w = new PlaceWatcher(NAMES);
  w.push(cells(5, "OOC_Stanton_2a_Cellin")); w.push(other);
  const p = w.current();
  ok("the OOC_ prefix and underscores are stripped to key the map", p.kind === "planet" && p.name === "Cellin", p);
  const w2 = new PlaceWatcher(NAMES);
  w2.push(cells(5, "pyro5a")); w2.push(other);
  const p2 = w2.current();
  ok("a body with no entry keeps its raw name rather than an invented one",
    p2.kind === "planet" && p2.name === "pyro5a", p2);
}

console.log("\nstaleness — the reading expires rather than lying");
{
  const w = new PlaceWatcher(NAMES);
  const t0 = 1_000_000;
  w.push(cells(137, "pyro2"), t0); w.push(other, t0);
  ok("fresh, it reports the planet", w.current(t0 + 60_000).kind === "planet");
  ok("past the staleness window it downgrades to unknown",
    w.current(t0 + PLACE_STALE_MS + 1).kind === "unknown");
  ok("...and the age is still reported so the widget can show it",
    (w.ageMs(t0 + PLACE_STALE_MS + 1) ?? 0) > PLACE_STALE_MS);
}

console.log("\nwording a 2,000-step signature");
{
  const planet: Place = { kind: "planet", body: "pyro2", name: "Monox", at: 0 };
  const space: Place = { kind: "space", at: 0 };
  ok("planet-side leads with harvestables", debrisStepWording(6, planet).lead === "6 harvestables");
  // Reversed 2026-08-11 on Sub's ruling — it used to offer "or 6 debris panels" here. He has never
  // seen debris on a planet, and hearing it called that was the complaint. The COUNT is unchanged;
  // only the kind he says cannot occur is dropped.
  ok("...and does NOT name debris planet-side", !debrisStepWording(6, planet).detail.includes("debris"));
  ok("...saying nothing rather than padding the line", debrisStepWording(6, planet).detail === "");
  ok("in space it leads with debris", debrisStepWording(6, space).lead === "6 debris panels");
  ok("...but still names harvestables", debrisStepWording(6, space).detail.includes("harvestable"));
  const u = debrisStepWording(6, { kind: "unknown" });
  ok("unknown commits to NEITHER — the count is the honest part", u.lead === "6 units", u);
  ok("...and offers both", u.detail === "debris panels or harvestables", u);
  ok("singular reads correctly", debrisStepWording(1, space).lead === "1 debris panel");
}

console.log(`\n${pass}/${pass + fail} passed`);
if (fail) process.exit(1);
