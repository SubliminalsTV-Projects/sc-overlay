/**
 * GATE 0 PROBE — throwaway diagnostic. DELETE once Gate 1 is settled.
 *
 * Question it answers: can a Vercel/datacenter IP fetch erkul's API, or does
 * Cloudflare 403 it? Everything in the public Twitch-extension plan assumes the
 * EBS can resolve erkul builds server-side from the cloud — this proves it.
 *
 * DEPLOY (from the subliminal.gg repo on a cloud host):
 *   1. Copy this file to:  app/api/erkul-probe/route.ts
 *   2. Commit + push (or `vercel deploy`) — a preview deploy is enough.
 *   3. READ:  curl https://<deploy-url>/api/erkul-probe   (or open in a browser)
 *   4. Read `verdict` first; details below it. Then DELETE the route + redeploy.
 *
 * Run it a couple of times — Vercel serverless egresses from a POOL of IPs, so
 * one PASS isn't a guarantee every IP is clear. A consistent PASS across a few
 * hits is the green light. A 403 on any hit means that IP is blocked.
 */

export const runtime = "nodejs"; // must NOT be edge — needs a normal datacenter fetch
export const dynamic = "force-dynamic"; // never cache the probe result

const API = "https://server.erkul.games";

// Same browser-like headers the local resolver uses (src/erkul.ts in sc-loadout-overlay).
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  Accept: "application/json",
  Origin: "https://www.erkul.games",
  Referer: "https://www.erkul.games/",
};

// A small, real saved build (Gladius). The decisive call is GET /loadouts/<id>.
const SAMPLE_LOADOUT = "8GTv2047";

async function probe(path: string) {
  const started = Date.now();
  try {
    const r = await fetch(API + path, {
      headers: HEADERS,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    const ms = Date.now() - started;
    const h = Object.fromEntries(r.headers);

    // Only read the body on failure (to capture the Cloudflare block page).
    // On success, discard it — /live/* responses can be many MB.
    let bodyPreview: string | null = null;
    if (!r.ok) bodyPreview = (await r.text()).slice(0, 400);
    else await r.body?.cancel().catch(() => {});

    return {
      path,
      ok: r.ok,
      status: r.status,
      ms,
      cfRay: h["cf-ray"] ?? null,
      cfCacheStatus: h["cf-cache-status"] ?? null,
      server: h["server"] ?? null,
      contentLength: h["content-length"] ?? null,
      rateLimit: {
        limit: h["x-ratelimit-limit"] ?? null,
        remaining: h["x-ratelimit-remaining"] ?? null,
        reset: h["x-ratelimit-reset"] ?? null,
      },
      bodyPreview, // null on success; CF block text on failure
    };
  } catch (e) {
    return { path, ok: false, status: 0, ms: Date.now() - started, error: String(e) };
  }
}

export async function GET() {
  // What egress IP did Vercel use? Informative for the erkul outreach (and for
  // judging whether a static-IP proxy would help if this FAILs). Serverless IPs
  // are ephemeral, so expect this to vary between runs.
  let egressIp: string | null = null;
  try {
    const j = await (
      await fetch("https://api.ipify.org?format=json", {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000),
      })
    ).json();
    egressIp = j.ip ?? null;
  } catch {
    /* non-fatal */
  }

  // The decisive call (small) + one reference endpoint. Same host, same
  // Cloudflare gate — if one is blocked by IP, all are.
  const loadout = await probe(`/loadouts/${SAMPLE_LOADOUT}`);
  const ref = await probe(`/live/coolers`);

  const blocked = loadout.status === 403 || ref.status === 403;
  const verdict = blocked
    ? "FAIL — 403 (Cloudflare blocks this IP). Need a proxy / residential resolver / erkul allowlist. Clean cloud EBS is NOT viable as-is."
    : loadout.ok && ref.ok
      ? "PASS — datacenter IP reached erkul. Clean cloud EBS is viable (still cache hard — see Gate 1)."
      : "INCONCLUSIVE — neither a clean 200 nor a 403. Inspect details + bodyPreview.";

  return Response.json(
    { verdict, egressIp, loadout, ref, checkedAt: new Date().toISOString() },
    { headers: { "cache-control": "no-store" } },
  );
}
