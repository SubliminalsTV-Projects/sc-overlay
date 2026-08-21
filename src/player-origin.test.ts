/**
 * Where the player is, and how much to believe it — `npx tsx src/player-origin.test.ts`.
 *
 * 🔴 THE BUG THIS FILE EXISTS TO PREVENT: the terrain report fires every ten minutes whatever the
 * player does, so the obvious "freshest signal wins" would replace an exact station fix with a
 * vague body reading within ten minutes of arriving — and keep doing it forever while the player
 * stood still. Precision would decay on a timer. Most of what follows is about telling that case
 * apart from a genuine move.
 */
import { resolveOrigin, originSummary, TRUST_MIN, type OriginSignal } from "./player-origin.js";

let failed = 0;
const check = (name: string, cond: boolean, detail = ""): void => {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail ? "  [" + detail + "]" : ""}`);
};

const NOW = 1_800_000_000_000;
const agoMin = (m: number): number => NOW - m * 60_000;
const now = () => NOW;

// A tiny world: Shubin SAL-2 sits on Lyria, in Stanton. Ruin Station is in Pyro.
const deps = {
  now,
  bodyOfPlace: (id: string): string | null =>
    id === "shubin-sal2" ? "lyria" : id === "area18" ? "arccorp" : id === "ruin" ? "pyro1" : null,
  systemOf: (id: string): string | null => {
    if (id === "ruin" || id === "pyro1") return "pyro";
    if (id === "shubin-sal2" || id === "area18" || id === "lyria" || id === "arccorp") return "stanton";
    return null;
  },
};
const sig = (tier: OriginSignal["tier"], id: string, label: string, mAgo: number, source = "test"): OriginSignal =>
  ({ tier, id, label, at: agoMin(mAgo), source });

console.log("🔴 the heartbeat must not erase a precise fix");
{
  // Standing at an outpost: the exact fix is 12 minutes old, the terrain report fired 2 min ago.
  // Freshest-wins would say "near Lyria". It must still say Shubin.
  const v = resolveOrigin([
    sig("place", "shubin-sal2", "Shubin SAL-2", 12, "inventory"),
    sig("body", "lyria", "Lyria", 2, "terrain report"),
  ], deps);
  check("the precise fix survives a newer body reading", v.tier === "place", v.tier);
  check("...and it is the right place", v.label === "Shubin SAL-2", v.label);
  check("...because the body CONTAINS it, so that is a refresh not a contradiction", !v.stale || v.ageMin! < TRUST_MIN.place);
}

console.log("\n🔴 but a CONTRADICTING body reading means the player moved");
{
  // Same old fix, but the terrain report now says Daymar — which is not Lyria. The player left.
  const v = resolveOrigin([
    sig("place", "shubin-sal2", "Shubin SAL-2", 12, "inventory"),
    sig("body", "daymar", "Daymar", 2, "terrain report"),
  ], deps);
  check("the stale precise fix is DROPPED, not merely caveated", v.tier === "body", v.tier);
  check("...and we report where they actually are", v.label === "Daymar", v.label);
}

console.log("\ntier precedence and freshness");
{
  const v = resolveOrigin([
    sig("place", "area18", "Area18", 3, "inventory"),
    sig("body", "arccorp", "ArcCorp", 1, "terrain report"),
    sig("system", "stanton", "Stanton", 0.5, "quantum route"),
  ], deps);
  check("with everything agreeing, the most precise wins", v.tier === "place", v.tier);
  check("...and it is not marked stale when fresh", v.stale === false, String(v.ageMin));
}
{
  // A place fix past its window falls through to the body.
  const v = resolveOrigin([
    sig("place", "area18", "Area18", TRUST_MIN.place + 5, "inventory"),
    sig("body", "arccorp", "ArcCorp", 3, "terrain report"),
  ], deps);
  check("an aged-out place fix yields to a live body reading", v.tier === "body", v.tier);
}
{
  // The body report has stopped for over two cycles — no longer near anything.
  const v = resolveOrigin([
    sig("body", "arccorp", "ArcCorp", TRUST_MIN.body + 5, "terrain report"),
    sig("system", "stanton", "Stanton", 40, "quantum route"),
  ], deps);
  check("a body reading that stopped two cycles ago yields to the system", v.tier === "system", v.tier);
  check("...and the system NEVER expires, however old", v.ageMin! > TRUST_MIN.body, v.ageMin!.toFixed(0) + " min");
}

console.log("\n🔴 it says UNKNOWN rather than picking a default origin");
{
  const v = resolveOrigin([], deps);
  check("nothing seen -> unknown", v.tier === "unknown", v.tier);
  check("...with no timestamp invented", v.at === null && v.ageMin === null);
  check("...and it still tells the player what to do", v.howToImprove.length > 30);
  check("...and the summary says so plainly", originSummary(v) === "Location unknown", originSummary(v));
}

console.log("\neverything aged out still reports a LAST-KNOWN rather than nothing");
{
  const v = resolveOrigin([sig("place", "area18", "Area18", 300, "inventory")], deps);
  check("a very old fix is still returned", v.tier === "place", v.tier);
  check("...but flagged stale", v.stale === true);
  check("...and the age is honest", Math.round(v.ageMin!) === 300, String(Math.round(v.ageMin!)));
}

console.log("\n🔴 every verdict carries a CONCRETE action, not just a caveat");
for (const tier of ["place", "body", "system", "unknown"] as const) {
  const sigs = tier === "unknown" ? [] : [sig(tier, "area18", "Area18", 1)];
  const v = resolveOrigin(sigs, deps);
  const t = v.howToImprove.toLowerCase();
  check(tier + ": names something the player can do",
    /inventory|terminal|quantum|cargo|fly|planet/.test(t), v.howToImprove.slice(0, 46));
}
{
  // ⚠️ Sub: the debug-overlay Sync is a last resort and must not be the instruction.
  const v = resolveOrigin([sig("place", "area18", "Area18", 1)], deps);
  check("the precise tier does NOT tell the player to go and sync", !/sync/i.test(v.howToImprove));
}

console.log("\nthe summary wording distinguishes the tiers");
{
  const place = originSummary(resolveOrigin([sig("place", "area18", "Area18", 0.2)], deps));
  const body = originSummary(resolveOrigin([sig("body", "arccorp", "ArcCorp", 5)], deps));
  const sys = originSummary(resolveOrigin([sig("system", "stanton", "Stanton", 90)], deps));
  check("a place reads as the place", place.startsWith("Area18"), place);
  check("a body reads as NEAR it", body.startsWith("near ArcCorp"), body);
  check("a system reads as somewhere IN it", sys.startsWith("somewhere in Stanton"), sys);
  check("...and an exact fix from 30s ago does not look like a 2h-old one", place !== sys && /just now/.test(place), place);
  check("hours are rendered as hours", /h ago/.test(sys), sys);
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
