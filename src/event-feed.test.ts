/**
 * The events phone-home feed: freshness, provenance, and the two things that must never happen —
 * a fetched correction being lost to `seedDataDir()`, and an older remote deleting a shipped
 * discovery.
 *
 * 🔑 EVERY FIXTURE HERE IS THIS FILE'S OWN. `data/events.json` is a live research artefact: its
 * `contracts`, `rewards`, `tiers` and `total` are added and withdrawn as they are measured in
 * game, and reading any of them into a MECHANISM test makes that test go red for a reason that
 * has nothing to do with the mechanism. That has already happened twice in `event-track.test.ts`
 * (first on `contracts`, then on `rewards` when the S-38 was confirmed). Nothing below opens the
 * shipped file.
 *
 * Run with:  npx tsx src/event-feed.test.ts
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventFeed, isUsableEventsFile } from "./event-feed.js";

let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (!cond) failed++;
  console.log(`${cond ? "ok  " : "FAIL"}  ${name}${detail && !cond ? "  [" + detail + "]" : ""}`);
}

const URL_ = "https://example.invalid/sc/events.json";

/** A minimal events file. `rev` is the ordering key; `reward` is the observable payload, so an
 *  assertion can say WHICH copy is in effect rather than only that something was written. */
function eventsFile(rev: number, reward: string | null) {
  return {
    schema: "sc-events/1",
    revision: rev,
    events: [
      {
        id: "fixture-event",
        log: "Fixture Event",
        label: "Fixture Event",
        tiers: [10, 50, 100],
        total: 1000,
        contracts: { FIX_A: 100 },
        rewards: reward ? [{ tier: 10, name: reward, item: null }] : [],
      },
    ],
  };
}

/** One test world: a bundled file, the working copy seeding produces from it, and a cache dir. */
function world(bundledRev: number, bundledReward: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "evfeed-"));
  const bundledPath = join(dir, "bundled-events.json");
  const workingPath = join(dir, "data", "events.json");
  const cachePath = join(dir, "state", "events-remote.json");
  writeFileSync(bundledPath, JSON.stringify(eventsFile(bundledRev, bundledReward), null, 2));
  seed();
  function seed(): void {
    // Exactly what `seedDataDir()` does: copy the bundle over the working copy, every start.
    mkdirSync(join(dir, "data"), { recursive: true });
    copyFileSync(bundledPath, workingPath);
  }
  const working = () => JSON.parse(readFileSync(workingPath, "utf8"));
  return { dir, bundledPath, workingPath, cachePath, seed, working };
}

/** A fetch stand-in that records what it was called with. */
function fakeFetch(reply: (headers: Record<string, string>) => { status: number; body?: string; etag?: string; lastModified?: string } | "throw") {
  const seen: Record<string, string>[] = [];
  const impl = (async (_url: string, init?: { headers?: Record<string, string> }) => {
    const headers = init?.headers ?? {};
    seen.push({ ...headers });
    const r = reply(headers);
    if (r === "throw") throw new Error("getaddrinfo ENOTFOUND");
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => (k.toLowerCase() === "etag" ? (r.etag ?? null) : k.toLowerCase() === "last-modified" ? (r.lastModified ?? null) : null) },
      text: async () => r.body ?? "",
    };
  }) as unknown as typeof fetch;
  return { impl, seen };
}

// ── 1. No cache, no network: the bundle is the floor ────────────────────────────────────────
{
  const w = world(1, "BUNDLED REWARD");
  const feed = new EventFeed({ ...w, url: null });
  const changed = feed.start();
  const s = feed.status();
  check("cold start reports source=bundled", s.source === "bundled", s.source);
  check("cold start reports the bundle's revision", s.revision === 1, String(s.revision));
  check("cold start does not rewrite the working copy", changed === false, String(changed));
  check("the working copy is the bundled one", w.working().events[0].rewards[0].name === "BUNDLED REWARD");
  check("no cache file is invented", !existsSync(w.cachePath));
  rmSync(w.dir, { recursive: true, force: true });
}

// ── 2. A newer remote is adopted, cached, and SAYS it is live ───────────────────────────────
{
  const w = world(1, "BUNDLED REWARD");
  const f = fakeFetch(() => ({ status: 200, body: JSON.stringify(eventsFile(2, "LIVE REWARD")), etag: 'W/"abc"', lastModified: "Wed, 21 Aug 2026 10:00:00 GMT" }));
  const feed = new EventFeed({ ...w, url: URL_, fetchImpl: f.impl });
  feed.start();
  const changed = await feed.refresh();
  const s = feed.status();
  check("a newer remote rewrites the working copy", changed === true, String(changed));
  check("the working copy now holds the REMOTE reward", w.working().events[0].rewards[0].name === "LIVE REWARD", JSON.stringify(w.working().events[0].rewards));
  check("source is reported as live", s.source === "live", s.source);
  check("the adopted revision is the remote one", s.revision === 2, String(s.revision));
  check("fetchedAt is stamped", typeof s.fetchedAt === "number" && (s.fetchedAt ?? 0) > 0);
  check("checkedAt is stamped", typeof s.checkedAt === "number" && (s.checkedAt ?? 0) > 0);
  check("no error is reported on success", s.lastError === null, String(s.lastError));
  const cache = JSON.parse(readFileSync(w.cachePath, "utf8"));
  check("the cache stores the body", cache.body?.events?.[0]?.rewards?.[0]?.name === "LIVE REWARD");
  check("the cache stores the ETag for the next conditional request", cache.etag === 'W/"abc"', String(cache.etag));
  check("the first request sent NO validators (nothing to validate)", Object.keys(f.seen[0]).length === 0, JSON.stringify(f.seen[0]));
  rmSync(w.dir, { recursive: true, force: true });
}

// ── 3. 🔴 THE SEEDING TRAP: a correction fetched last session survives the next start ───────
// This is the assertion the whole module exists for. `seedDataDir()` copies the bundle over the
// working copy on EVERY start, so a fetched events.json written into dataDir is destroyed by the
// next launch. The durable copy lives outside the seeded dir, and start() must replay it.
{
  const w = world(1, "BUNDLED REWARD");
  const f = fakeFetch(() => ({ status: 200, body: JSON.stringify(eventsFile(2, "LIVE REWARD")), etag: 'W/"abc"' }));
  const feed = new EventFeed({ ...w, url: URL_, fetchImpl: f.impl });
  feed.start();
  await feed.refresh();
  check("(setup) the correction was adopted before the restart", w.working().events[0].rewards[0].name === "LIVE REWARD");

  // --- restart ---
  w.seed(); // seedDataDir() runs and destroys the fetched copy
  check("(control) seeding really does clobber the working copy", w.working().events[0].rewards[0].name === "BUNDLED REWARD");
  const feed2 = new EventFeed({ ...w, url: null }); // offline this session
  const changed = feed2.start();
  const s = feed2.status();
  check("the cached correction is replayed over the freshly-seeded copy", changed === true, String(changed));
  check("the working copy holds the fetched reward again, with NO network", w.working().events[0].rewards[0].name === "LIVE REWARD", JSON.stringify(w.working().events[0].rewards));
  check("source is reported as cache, not live", s.source === "cache", s.source);
  check("the cached revision is reported", s.revision === 2, String(s.revision));
  check("checkedAt is null before any attempt this session", s.checkedAt === null, String(s.checkedAt));
  rmSync(w.dir, { recursive: true, force: true });
}

// ── 4. 🔴 AN OLDER REMOTE IS REFUSED — the regression this design exists to prevent ─────────
// Sub measures a reward, edits data/events.json, ships a release. The site is still serving the
// pre-discovery copy. A remote-always-wins client would fetch it and delete the S-38.
{
  const w = world(5, "SHIPPED DISCOVERY");
  const f = fakeFetch(() => ({ status: 200, body: JSON.stringify(eventsFile(3, "STALE SITE COPY")), etag: 'W/"old"' }));
  const feed = new EventFeed({ ...w, url: URL_, fetchImpl: f.impl });
  feed.start();
  const changed = await feed.refresh();
  const s = feed.status();
  check("an older remote does not rewrite the working copy", changed === false, String(changed));
  check("the shipped discovery survives", w.working().events[0].rewards[0].name === "SHIPPED DISCOVERY", JSON.stringify(w.working().events[0].rewards));
  check("source stays bundled", s.source === "bundled", s.source);
  check("the effective revision stays the bundle's", s.revision === 5, String(s.revision));
  check("a refused-but-valid remote is not an error", s.lastError === null, String(s.lastError));
  check("a refused body is NOT cached", !existsSync(w.cachePath));
  rmSync(w.dir, { recursive: true, force: true });
}

// ── 4b. 🔴 A REFUSED REMOTE MUST NOT DESTROY THE ADOPTED CACHE ──────────────────────────────
// The bug this exists for was invisible to every assertion above, because they all live inside
// ONE session: the cache was being written on every 200, adopted or not, so a session that
// adopted revision 4 and then saw a stale revision 2 kept running perfectly — and came back up
// on the BUNDLE at the next launch with the discovery gone. Found by driving a real sidecar
// through adopt -> regress -> restart, which is a sequence no single-session test can express.
{
  const w = world(1, "BUNDLED REWARD");
  let serving = { rev: 4, reward: "ADOPTED DISCOVERY" };
  const f = fakeFetch(() => ({ status: 200, body: JSON.stringify(eventsFile(serving.rev, serving.reward)), etag: `W/"r${serving.rev}"` }));
  const feed = new EventFeed({ ...w, url: URL_, fetchImpl: f.impl });
  feed.start();
  await feed.refresh();
  check("(setup) revision 4 was adopted", feed.status().revision === 4 && w.working().events[0].rewards[0].name === "ADOPTED DISCOVERY", String(feed.status().revision));

  // The site regresses — a stale deploy, or a rollback.
  serving = { rev: 2, reward: "STALE SITE COPY" };
  await feed.refresh();
  check("the stale copy is refused in-session", w.working().events[0].rewards[0].name === "ADOPTED DISCOVERY", JSON.stringify(w.working().events[0].rewards));
  check("the cache still holds the ADOPTED revision, not the refused one", JSON.parse(readFileSync(w.cachePath, "utf8")).body.revision === 4, String(JSON.parse(readFileSync(w.cachePath, "utf8")).body.revision));

  // --- restart, offline. This is where the loss used to become visible. ---
  w.seed();
  const feed2 = new EventFeed({ ...w, url: null });
  feed2.start();
  check("after a restart the ADOPTED discovery is still in effect", w.working().events[0].rewards[0].name === "ADOPTED DISCOVERY", JSON.stringify(w.working().events[0].rewards));
  check("...at the adopted revision", feed2.status().revision === 4, String(feed2.status().revision));
  check("...reported as cache", feed2.status().source === "cache", feed2.status().source);
  rmSync(w.dir, { recursive: true, force: true });
}

// ── 5. An EQUAL revision is refused too (strictly-greater, not >=) ──────────────────────────
{
  const w = world(4, "BUNDLED REWARD");
  const f = fakeFetch(() => ({ status: 200, body: JSON.stringify(eventsFile(4, "SAME REVISION, DIFFERENT BODY")) }));
  const feed = new EventFeed({ ...w, url: URL_, fetchImpl: f.impl });
  feed.start();
  const changed = await feed.refresh();
  check("an equal revision is not adopted", changed === false, String(changed));
  check("the working copy is untouched", w.working().events[0].rewards[0].name === "BUNDLED REWARD");
  rmSync(w.dir, { recursive: true, force: true });
}

// ── 6. A conditional 304 keeps the cache and is NOT an error ────────────────────────────────
{
  const w = world(1, "BUNDLED REWARD");
  let phase = 0;
  const f = fakeFetch((h) => {
    phase++;
    if (phase === 1) return { status: 200, body: JSON.stringify(eventsFile(2, "LIVE REWARD")), etag: 'W/"v2"', lastModified: "Wed, 21 Aug 2026 10:00:00 GMT" };
    // Second call must arrive WITH the validators, or the server can never answer 304.
    return h["If-None-Match"] === 'W/"v2"' ? { status: 304 } : { status: 200, body: JSON.stringify(eventsFile(9, "SERVER SAW NO VALIDATOR")) };
  });
  const feed = new EventFeed({ ...w, url: URL_, fetchImpl: f.impl });
  feed.start();
  await feed.refresh();
  const changed = await feed.refresh();
  const s = feed.status();
  check("the second request sent If-None-Match", f.seen[1]?.["If-None-Match"] === 'W/"v2"', JSON.stringify(f.seen[1]));
  check("the second request sent If-Modified-Since", f.seen[1]?.["If-Modified-Since"] === "Wed, 21 Aug 2026 10:00:00 GMT", JSON.stringify(f.seen[1]));
  check("a 304 reports no change", changed === false, String(changed));
  check("a 304 is not an error", s.lastError === null, String(s.lastError));
  check("a 304 keeps the live copy in effect", w.working().events[0].rewards[0].name === "LIVE REWARD");
  check("a 304 keeps the adopted revision", s.revision === 2, String(s.revision));
  rmSync(w.dir, { recursive: true, force: true });
}

// ── 7. Garbage is refused before it can be cached ───────────────────────────────────────────
// A truncated body or an HTML error page must never become the copy we replay next session.
{
  const w = world(1, "BUNDLED REWARD");
  const f = fakeFetch(() => ({ status: 200, body: "<html>502 Bad Gateway</html>" }));
  const feed = new EventFeed({ ...w, url: URL_, fetchImpl: f.impl });
  feed.start();
  const changed = await feed.refresh();
  const s = feed.status();
  check("a non-JSON body is refused", changed === false, String(changed));
  check("a non-JSON body sets lastError", typeof s.lastError === "string" && s.lastError.includes("JSON"), String(s.lastError));
  check("a non-JSON body is NOT cached", !existsSync(w.cachePath));
  check("the working copy is untouched", w.working().events[0].rewards[0].name === "BUNDLED REWARD");
  rmSync(w.dir, { recursive: true, force: true });
}

// ── 8. Valid JSON that the tracker would silently discard is refused ────────────────────────
// Adopting a file MissionTracker.loadEvents() then drops would leave us reporting "live" while
// running on nothing at all — the worst possible combination.
{
  const w = world(1, "BUNDLED REWARD");
  const f = fakeFetch(() => ({ status: 200, body: JSON.stringify({ schema: "sc-events/1", revision: 99, events: [{ id: "no-log-field" }] }) }));
  const feed = new EventFeed({ ...w, url: URL_, fetchImpl: f.impl });
  feed.start();
  const changed = await feed.refresh();
  const s = feed.status();
  check("an event with no `log` makes the whole file unusable", changed === false, String(changed));
  check("that is reported as an error", typeof s.lastError === "string" && s.lastError.includes("usable"), String(s.lastError));
  check("it is not cached", !existsSync(w.cachePath));
  check("source stays bundled despite the higher revision", s.source === "bundled" && s.revision === 1, `${s.source}/${s.revision}`);
  rmSync(w.dir, { recursive: true, force: true });
}

// ── 9. Offline is a no-op that says so ──────────────────────────────────────────────────────
{
  const w = world(1, "BUNDLED REWARD");
  const f = fakeFetch(() => "throw");
  const feed = new EventFeed({ ...w, url: URL_, fetchImpl: f.impl });
  feed.start();
  const changed = await feed.refresh();
  const s = feed.status();
  check("a network failure changes nothing", changed === false, String(changed));
  check("a network failure is reported", typeof s.lastError === "string" && s.lastError.length > 0, String(s.lastError));
  check("checkedAt is still stamped on a failed attempt", typeof s.checkedAt === "number", String(s.checkedAt));
  check("source and revision are unchanged", s.source === "bundled" && s.revision === 1, `${s.source}/${s.revision}`);
  check("the working copy is untouched", w.working().events[0].rewards[0].name === "BUNDLED REWARD");
  rmSync(w.dir, { recursive: true, force: true });
}

// ── 10. A missing url disables refreshing without erroring ──────────────────────────────────
{
  const w = world(1, "BUNDLED REWARD");
  const f = fakeFetch(() => ({ status: 200, body: JSON.stringify(eventsFile(9, "SHOULD NEVER LAND")) }));
  const feed = new EventFeed({ ...w, url: "", fetchImpl: f.impl });
  feed.start();
  const changed = await feed.refresh();
  check("no url means no fetch is attempted", f.seen.length === 0, String(f.seen.length));
  check("no url means no change", changed === false, String(changed));
  check("no url is not an error", feed.status().lastError === null, String(feed.status().lastError));
  rmSync(w.dir, { recursive: true, force: true });
}

// ── 11. isUsableEventsFile matches loadEvents()'s own bar ───────────────────────────────────
// Positive first: if the accepting cases silently stopped accepting, every rejecting case below
// would pass for free.
{
  check("a normal file is usable", isUsableEventsFile(eventsFile(1, "x")));
  check("an EMPTY events list is usable (a legitimate 'no events declared')", isUsableEventsFile({ events: [] }));
  check("a missing events array is not usable", !isUsableEventsFile({ schema: "sc-events/1" }));
  check("events not being an array is not usable", !isUsableEventsFile({ events: "nope" }));
  check("an entry with no id is not usable", !isUsableEventsFile({ events: [{ log: "X" }] }));
  check("an entry with a blank log is not usable", !isUsableEventsFile({ events: [{ id: "a", log: "   " }] }));
  check("null is not usable", !isUsableEventsFile(null));
}

console.log(failed ? `\nFAILED (${failed})` : "\nAll event-feed assertions passed");
process.exit(failed ? 1 : 0);
