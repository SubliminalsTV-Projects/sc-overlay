#!/usr/bin/env python3
"""ArchVerse Alpha 18 chat security hardening.

Threats addressed:
- The sidecar's read-only Chat HTTP/SSE endpoints were reachable from the LAN on port 8778 and
  exposed current channel/shard identifiers and message history.
- The legacy production chat backend publicly enumerated room identifiers in /health.
- In site/production auth mode, a client-supplied `loc` frame directly granted region/shard room
  membership. Knowing/guessing a room ID was therefore sufficient to request membership.

Security model after this repair:
- Local Chat state/events/send are loopback-only.
- ArchVerse does not transmit region/shard location to the known legacy production endpoint;
  Global remains usable while Server/Shard tabs are security-restricted.
- Hardened chat-server source exposes only a generic public health result.
- Hardened site-mode chat-server ignores client location as authority. Region/shard membership may
  only come from the trusted site auth response (`channels`), so the safe fallback is Global-only
  until the site can independently attest location.
- Admin HTTP actions require both loopback and CHAT_ADMIN_TOKEN.
"""
from pathlib import Path
import sys

root = Path(sys.argv[1])
chat_ts = root / "src/chat.ts"
overlay_server = root / "src/overlay-server.ts"
chat_html = root / "overlay/chat.html"
backend = root / "chat-server/server.mjs"

for p in (chat_ts, overlay_server, chat_html, backend):
    if not p.exists():
        raise SystemExit(f"chat security repair: missing {p}")

# ---------------------------------------------------------------------------
# Client: do not send local shard/region to the known legacy backend.
# Keep Global chat available so the feature is not needlessly removed.
# ---------------------------------------------------------------------------
s = chat_ts.read_text()

anchor = 'const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];\n'
insert = '''const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
// Security quarantine: upstream 0.1.41's production backend trusts a client-supplied `loc`
// frame as room authority. Until that backend is deployed with server-side room grants, never
// disclose or request region/shard membership there. Custom/local backends remain available for
// development and self-hosted hardened deployments. An explicit environment escape hatch exists
// only for controlled testing; it is intentionally not exposed in Settings.
const LEGACY_UNATTESTED_CHAT_RE = /^wss:\/\/chat\.subliminal\.gg(?:\/|$)/i;
const ALLOW_UNATTESTED_CHAT_LOCATION = process.env.ARCHVERSE_ALLOW_UNATTESTED_CHAT_LOCATION === "1";
'''
if 'LEGACY_UNATTESTED_CHAT_RE' not in s:
    if anchor not in s:
        raise SystemExit('chat security repair: chat.ts constant anchor missing')
    s = s.replace(anchor, insert, 1)

anchor = '''  private wsSend(frame: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private sendLoc(): void {
    if (this.status !== "connected") return;
    this.wsSend({ t: "loc", region: regionOfShard(this.shard), shard: this.shard });
  }
'''
replacement = '''  private wsSend(frame: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private locationChannelsAllowed(): boolean {
    const url = this.opts?.url ?? "";
    return ALLOW_UNATTESTED_CHAT_LOCATION || !LEGACY_UNATTESTED_CHAT_RE.test(url);
  }

  private sendLoc(): void {
    if (this.status !== "connected") return;
    // Do not send the player's shard/region to a backend that lets the client choose its own room.
    // The connection remains in Global only. This also prevents ArchVerse from disclosing the
    // player's current shard to that endpoint while it is in the security quarantine.
    if (!this.locationChannelsAllowed()) return;
    this.wsSend({ t: "loc", region: regionOfShard(this.shard), shard: this.shard });
  }
'''
if 'private locationChannelsAllowed()' not in s:
    if anchor not in s:
        raise SystemExit('chat security repair: chat.ts sendLoc anchor missing')
    s = s.replace(anchor, replacement, 1)

anchor = '''      shardLabel: shardLabel(this.shard),
      channels,
'''
replacement = '''      shardLabel: shardLabel(this.shard),
      // Renderer-visible explanation for why Server/Shard tabs are intentionally unavailable.
      locationRestricted: !this.locationChannelsAllowed(),
      channels,
'''
if 'locationRestricted: !this.locationChannelsAllowed()' not in s:
    if anchor not in s:
        raise SystemExit('chat security repair: chat.ts view anchor missing')
    s = s.replace(anchor, replacement, 1)
chat_ts.write_text(s)

# ---------------------------------------------------------------------------
# Local sidecar: Chat state/history is private to this machine, same as sending.
# ---------------------------------------------------------------------------
s = overlay_server.read_text()

anchor = '''  if (url === "/chat/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
'''
replacement = '''  if (url === "/chat/events") {
    // Chat state includes current shard/channel identifiers and message history. Never expose it
    // to LAN clients through the sidecar's tablet-accessible listener.
    if (!fromThisMachine(req)) { res.writeHead(403); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
'''
if 'Chat state includes current shard/channel identifiers' not in s:
    if anchor not in s:
        raise SystemExit('chat security repair: /chat/events anchor missing')
    s = s.replace(anchor, replacement, 1)

anchor = '''  if (url === "/api/chat" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
'''
replacement = '''  if (url === "/api/chat" && req.method === "GET") {
    // Same privacy boundary as /chat/events and /api/chat/send: only this machine may read chat.
    if (!fromThisMachine(req)) {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: "Chat state is private to this machine." }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
'''
if 'Chat state is private to this machine.' not in s:
    if anchor not in s:
        raise SystemExit('chat security repair: /api/chat anchor missing')
    s = s.replace(anchor, replacement, 1)
overlay_server.write_text(s)

# ---------------------------------------------------------------------------
# Renderer: make the security fallback explicit instead of looking broken.
# ---------------------------------------------------------------------------
s = chat_html.read_text()

css_anchor = '''  #sendbar { flex: none; display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--divider);
    position: relative; z-index: 4; }
'''
css_replacement = '''  #securityNote { flex: none; padding: 6px 10px; border-top: 1px solid var(--divider);
    font-size: 10.5px; line-height: 1.45; color: var(--gold); background: rgba(0, 0, 0, 0.18);
    position: relative; z-index: 4; }
  #sendbar { flex: none; display: flex; gap: 6px; padding: 8px 10px; border-top: 1px solid var(--divider);
    position: relative; z-index: 4; }
'''
if '#securityNote {' not in s:
    if css_anchor not in s:
        raise SystemExit('chat security repair: chat.html CSS anchor missing')
    s = s.replace(css_anchor, css_replacement, 1)

html_anchor = '''    <div id="sendbar">
'''
html_replacement = '''    <div id="securityNote" hidden>Server/Shard chat is temporarily disabled for security. Global remains available while room membership is moved to server-side authorization.</div>

    <div id="sendbar">
'''
if 'id="securityNote"' not in s:
    if html_anchor not in s:
        raise SystemExit('chat security repair: chat.html body anchor missing')
    s = s.replace(html_anchor, html_replacement, 1)

js_anchor = '''    p.classList.toggle("on", view?.status === "connected");
    p.classList.toggle("gated", view ? !view.hasIdentity : false);
'''
js_replacement = '''    p.classList.toggle("on", view?.status === "connected");
    p.classList.toggle("gated", view ? !view.hasIdentity : false);
    $("securityNote").hidden = !view?.locationRestricted;
'''
if '$("securityNote").hidden = !view?.locationRestricted;' not in s:
    if js_anchor not in s:
        raise SystemExit('chat security repair: chat.html render anchor missing')
    s = s.replace(js_anchor, js_replacement, 1)
chat_html.write_text(s)

# ---------------------------------------------------------------------------
# Backend source hardening for self-host/upstream deployment.
# This does NOT pretend the developer's existing VPS changed simply because the client updated.
# ---------------------------------------------------------------------------
s = backend.read_text()

# Add crypto helper and bind/admin controls.
s = s.replace('import { createServer } from "node:http";\n', 'import { createServer } from "node:http";\nimport { timingSafeEqual } from "node:crypto";\n', 1) if 'timingSafeEqual' not in s else s
anchor = 'const PORT = Number(process.env.CHAT_PORT) || 8788;\n'
replacement = '''const PORT = Number(process.env.CHAT_PORT) || 8788;
const HOST = process.env.CHAT_HOST || (process.env.CHAT_AUTH === "site" ? "0.0.0.0" : "127.0.0.1");
'''
if 'const HOST = process.env.CHAT_HOST' not in s:
    if anchor not in s: raise SystemExit('chat security repair: backend PORT anchor missing')
    s = s.replace(anchor, replacement, 1)
anchor = 'const AUTH_URL = process.env.CHAT_AUTH_URL || "https://subliminal.gg/api/sc/chat-auth";\n'
replacement = '''const AUTH_URL = process.env.CHAT_AUTH_URL || "https://subliminal.gg/api/sc/chat-auth";
const ADMIN_TOKEN = String(process.env.CHAT_ADMIN_TOKEN || "");
'''
if 'const ADMIN_TOKEN =' not in s:
    if anchor not in s: raise SystemExit('chat security repair: backend AUTH_URL anchor missing')
    s = s.replace(anchor, replacement, 1)

# Trusted auth response may carry server-authorized rooms. With the current auth response this is
# empty, therefore production safely falls back to Global-only.
anchor = '''    if (d?.verified !== true || !HANDLE_RE.test(handle)) return { handle: "", verified: false };
    return { handle, verified: true };
'''
replacement = '''    if (d?.verified !== true || !HANDLE_RE.test(handle)) return { handle: "", verified: false, channels: [] };
    const channels = Array.isArray(d?.channels)
      ? d.channels.map((ch) => String(ch).toLowerCase()).filter((ch) =>
          ch === "global" || /^region:[a-z0-9]{3,12}$/.test(ch) || /^shard:[a-z0-9][a-z0-9_-]{4,63}$/.test(ch))
      : [];
    return { handle, verified: true, channels };
'''
if 'const channels = Array.isArray(d?.channels)' not in s:
    if anchor not in s: raise SystemExit('chat security repair: backend auth-return anchor missing')
    s = s.replace(anchor, replacement, 1)

# Generic public health: no room IDs, counts, or auth-mode details.
anchor = '''  if (url === "/health") {
    const roomStats = {};
    for (const [ch, r] of rooms) roomStats[ch] = r.members.size;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, mode: AUTH_MODE, connections: wss.clients.size, rooms: roomStats }));
    return;
  }
'''
replacement = '''  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
'''
if 'rooms: roomStats' in s:
    if anchor not in s: raise SystemExit('chat security repair: backend health anchor missing')
    s = s.replace(anchor, replacement, 1)

# Admin endpoints require both loopback and a secret. This avoids trusting proxy topology alone.
loop_anchor = '''const loopback = (req) => {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
};
'''
loop_replacement = '''const loopback = (req) => {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
};
function adminAuthorized(req) {
  if (!loopback(req) || !ADMIN_TOKEN) return false;
  const raw = String(req.headers.authorization || "");
  const got = raw.startsWith("Bearer ") ? raw.slice(7) : "";
  if (!got) return false;
  const a = Buffer.from(got), b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
'''
if 'function adminAuthorized(req)' not in s:
    if loop_anchor not in s: raise SystemExit('chat security repair: backend loopback anchor missing')
    s = s.replace(loop_anchor, loop_replacement, 1)
s = s.replace('if (url.startsWith("/admin/") && !loopback(req)) { res.writeHead(403); res.end(); return; }',
              'if (url.startsWith("/admin/") && !adminAuthorized(req)) { res.writeHead(403); res.end(); return; }', 1)

# Site mode: join only rooms returned by the trusted auth service. Never grant rooms from client loc.
anchor = '''      conn.send({ t: "welcome", you: { handle: conn.handle, verified: conn.verified } });
      joinRoom(conn, "global");
      return;
'''
replacement = '''      conn.send({ t: "welcome", you: { handle: conn.handle, verified: conn.verified } });
      joinRoom(conn, "global");
      if (AUTH_MODE === "site") {
        for (const ch of id.channels ?? []) if (ch !== "global") joinRoom(conn, ch);
      }
      return;
'''
if 'for (const ch of id.channels ?? [])' not in s:
    if anchor not in s: raise SystemExit('chat security repair: backend hello/join anchor missing')
    s = s.replace(anchor, replacement, 1)

anchor = '''    if (f.t === "loc") {
      const want = new Set(locChannels(f));
'''
replacement = '''    if (f.t === "loc") {
      if (AUTH_MODE === "site") {
        conn.send({ t: "error", code: "location_not_authorized", message: "Server/Shard membership requires server authorization." });
        return;
      }
      const want = new Set(locChannels(f));
'''
if 'location_not_authorized' not in s:
    if anchor not in s: raise SystemExit('chat security repair: backend loc anchor missing')
    s = s.replace(anchor, replacement, 1)

# Dev auth should not accidentally bind publicly by default; site remains externally reachable.
s = s.replace('server.listen(PORT, () => {\n', 'server.listen(PORT, HOST, () => {\n', 1)
s = s.replace('console.log(`[chat-server] listening on :${PORT} (auth=${AUTH_MODE}, bans=${bans.size})`);',
              'console.log(`[chat-server] listening on ${HOST}:${PORT} (auth=${AUTH_MODE}, bans=${bans.size})`);', 1)
backend.write_text(s)

# ---------------------------------------------------------------------------
# Add a source-level regression test that runs in the normal upstream test sweep.
# ---------------------------------------------------------------------------
test = root / "src/archverse-chat-security.test.ts"
test.write_text(r'''import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ChatClient } from "./chat.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const backend = readFileSync(join(repo, "chat-server/server.mjs"), "utf8");
const sidecar = readFileSync(join(repo, "src/overlay-server.ts"), "utf8");

assert(!backend.includes("rooms: roomStats"), "public health must not enumerate rooms");
assert(backend.includes("location_not_authorized"), "site-mode client loc must be rejected");
assert(backend.includes("id.channels ?? []"), "site-mode rooms must come from trusted auth response");
assert(backend.includes("adminAuthorized(req)"), "admin endpoints require token authorization");
assert(sidecar.includes("Chat state is private to this machine."), "/api/chat must be loopback-only");
assert(sidecar.includes("Chat state includes current shard/channel identifiers"), "/chat/events must be loopback-only");

const legacy = new ChatClient();
legacy.configure({ url: "wss://chat.subliminal.gg/ws", handle: "", token: "token" }, false);
assert.equal((legacy.view() as any).locationRestricted, true, "legacy production location channels quarantined");
const local = new ChatClient();
local.configure({ url: "ws://127.0.0.1:8788/ws", handle: "DevUser", token: "" }, false);
assert.equal((local.view() as any).locationRestricted, false, "local hardened/dev backend retains location channels");
console.log("archverse chat security contract: ok");
''')

print('[alpha18-chat-security] local endpoints locked; legacy location channels quarantined; hardened backend source applied')
