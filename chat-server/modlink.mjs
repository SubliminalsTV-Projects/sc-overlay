// SC Overlay chat — the link between this server and the moderation portal on subliminal.gg.
//
// The portal is the RECORD (a page behind an admin role, because other people will moderate and
// Sub does not want them in Mission Control); Discord is the NOTIFICATION. This module is how
// the two ends talk, and the direction of every call here is the point:
//
// 🔴 THIS SERVER ONLY EVER DIALS OUT. Every `/admin/*` route is loopback-gated on purpose — an
// endpoint that ACTS with authority IS the authority — so moderation must not be reachable from
// the internet at any price, not even behind a token. Both halves therefore originate here: we
// PUSH events out, and we PULL pending actions in. The public attack surface of the chat server
// is unchanged by this file, which is the only reason it can exist.
//
// 🔑 The pull half is shaped exactly like the site's existing announce-queue that Minion drains
// (`GET /queue` → rows, `POST /queue/<id>` → mark done). One queue idiom on the site, already
// deployed and understood, rather than a second one invented for this.

const DEFAULT_POLL_MS = 20_000;

/** @param {{webhookUrl?: string, actionUrl?: string, secret?: string, pollMs?: number,
 *           log?: Console, onAction?: (row: any) => Promise<any>|any}} opts */
export function createModLink({ webhookUrl, actionUrl, secret, pollMs, log = console, onAction } = {}) {
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${secret ?? ""}` };
  const pushOn = !!(webhookUrl && secret);
  const pullOn = !!(actionUrl && secret && onAction);
  let timer = null;
  let inFlight = false;

  if ((webhookUrl || actionUrl) && !secret) {
    // Loud, because the failure is silent otherwise: a URL with no secret simply never fires and
    // moderation looks like it is working while nothing has ever left the process.
    log?.error?.("[modlink] a moderation URL is set but MOD_SHARED_SECRET is not — disabled");
  }
  log?.log?.(`[modlink] push=${pushOn} pull=${pullOn}`);

  /** Send one event outward. Fire-and-forget by design — a moderation webhook must never be able
   *  to delay or fail a live chat message, and the DB row is written either way, so a lost push
   *  costs the Discord ping and nothing else. Three tries, because the common failure is the
   *  site restarting mid-deploy and being back seconds later. */
  async function push(event) {
    if (!pushOn) return false;
    const body = JSON.stringify(event);
    for (let i = 0; i < 3; i++) {
      try {
        const res = await fetch(webhookUrl, {
          method: "POST", headers: auth, body, signal: AbortSignal.timeout(8000),
        });
        if (res.ok) return true;
        // A 4xx is our bug (bad secret, bad shape) and retrying it just repeats it.
        if (res.status < 500) { log?.error?.(`[modlink] push refused ${res.status}`); return false; }
      } catch (e) {
        if (i === 2) log?.error?.(`[modlink] push failed: ${e?.message}`);
      }
      if (i < 2) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
    return false;
  }

  /** Drain whatever the portal has queued. Each row is acked individually, so one action that
   *  throws cannot strand the rest of the queue behind it. */
  async function drain() {
    if (!pullOn || inFlight) return 0;
    inFlight = true;
    let done = 0;
    try {
      const res = await fetch(actionUrl, { headers: auth, signal: AbortSignal.timeout(8000) });
      if (!res.ok) { if (res.status !== 404) log?.error?.(`[modlink] queue read ${res.status}`); return 0; }
      const rows = (await res.json())?.rows;
      if (!Array.isArray(rows)) return 0;
      for (const row of rows) {
        let status = "applied", error = "";
        try { await onAction(row); } catch (e) { status = "failed"; error = String(e?.message ?? e).slice(0, 300); }
        try {
          await fetch(`${actionUrl.replace(/\/$/, "")}/${encodeURIComponent(row.id)}`, {
            method: "POST", headers: auth, body: JSON.stringify({ status, error }),
            signal: AbortSignal.timeout(8000),
          });
        } catch (e) {
          // 🔑 An un-acked action is RE-DELIVERED on the next poll, so both actions have to be
          // idempotent — banning an already-banned handle and lifting an absent ban are both
          // no-ops. That is what makes at-least-once delivery safe here.
          log?.error?.(`[modlink] ack failed for ${row.id}: ${e?.message}`);
        }
        done++;
      }
    } catch (e) {
      log?.error?.(`[modlink] queue poll failed: ${e?.message}`);
    } finally { inFlight = false; }
    return done;
  }

  function start() {
    if (!pullOn || timer) return;
    timer = setInterval(() => { drain(); }, pollMs || DEFAULT_POLL_MS);
    timer.unref?.(); // never hold the process open for a poll
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }

  return { push, drain, start, stop, pushOn, pullOn };
}
