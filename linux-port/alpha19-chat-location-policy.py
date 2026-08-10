#!/usr/bin/env python3
"""Preserve ArchVerse's stricter location-channel policy on upstream 0.1.42.

Upstream 0.1.42 substantially hardens chat, and those protections are kept intact. One trust
boundary remains intentionally stricter in ArchVerse: the production chat service still accepts a
client-generated `loc` frame for region/Nearby membership. Until CIG exposes a sanctioned way for a
backend to attest a player's live server/DGS, ArchVerse will not use client-controlled game-log
location as authorization for remote location rooms.

Global, verified-org, custom/private rooms, invites and DMs remain available. Only automatic
region/Nearby membership is suppressed against the known production endpoint. Self-hosted/test
servers may opt in explicitly with ARCHVERSE_ALLOW_UNATTESTED_CHAT_LOCATION=1.
"""
from pathlib import Path
import sys

root = Path(sys.argv[1])
chat = root / "src/chat.ts"
if not chat.exists():
    raise SystemExit(f"alpha19 chat policy: missing {chat}")

s = chat.read_text()

anchor = 'const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];\n'
insert = '''const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000];
// ArchVerse security policy: upstream 0.1.42's production backend still accepts a client-generated
// `loc` frame as authority for automatic region/Nearby membership. A modified client owns its
// Game.log input and can therefore lie. Keep those two tiers disabled against the known production
// service until room membership can be independently attested server-side.
const ARCHVERSE_UNATTESTED_LOCATION_RE = /^wss:\/\/chat\.subliminal\.gg(?:\/|$)/i;
const ARCHVERSE_ALLOW_UNATTESTED_LOCATION = process.env.ARCHVERSE_ALLOW_UNATTESTED_CHAT_LOCATION === "1";
'''
if 'ARCHVERSE_UNATTESTED_LOCATION_RE' not in s:
    if anchor not in s:
        raise SystemExit('alpha19 chat policy: BACKOFF anchor missing')
    s = s.replace(anchor, insert, 1)

anchor = '''  private wsSend(frame: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private sendLoc(): void {
    if (this.status !== "connected") return;
    // 🔑 The HASH goes on the wire, never the endpoint. The server keys the room on whatever
    // it is given, so if the raw ip:port ever left this process it would be published to every
    // user of the channel.
    this.wsSend({
      t: "loc", region: regionOfShard(this.shard), shard: this.shard,
      dgs: dgsKey(this.shard, this.dgs),
    });
  }
'''
replacement = '''  private wsSend(frame: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(frame));
  }

  private locationChannelsAllowed(): boolean {
    const url = this.opts?.url ?? "";
    return ARCHVERSE_ALLOW_UNATTESTED_LOCATION || !ARCHVERSE_UNATTESTED_LOCATION_RE.test(url);
  }

  private sendLoc(): void {
    if (this.status !== "connected") return;
    if (!this.locationChannelsAllowed()) return;
    // 🔑 The HASH goes on the wire, never the endpoint. The server keys the room on whatever
    // it is given, so if the raw ip:port ever left this process it would be published to every
    // user of the channel.
    this.wsSend({
      t: "loc", region: regionOfShard(this.shard), shard: this.shard,
      dgs: dgsKey(this.shard, this.dgs),
    });
  }
'''
if 'private locationChannelsAllowed()' not in s:
    if anchor not in s:
        raise SystemExit('alpha19 chat policy: sendLoc anchor missing')
    s = s.replace(anchor, replacement, 1)

anchor = '''      shardLabel: shardLabel(this.shard),
      channels,
'''
replacement = '''      shardLabel: shardLabel(this.shard),
      locationRestricted: !this.locationChannelsAllowed(),
      channels,
'''
if 'locationRestricted: !this.locationChannelsAllowed()' not in s:
    if anchor not in s:
        raise SystemExit('alpha19 chat policy: view anchor missing')
    s = s.replace(anchor, replacement, 1)

chat.write_text(s)
print('[alpha19-chat-policy] upstream 0.1.42 chat kept; production location-room authority quarantined')
