# SC Overlay social chat server

EVE-style player chat for the overlay, with a three-tier channel hierarchy that follows the
Game.log:

| channel | who | from |
|---|---|---|
| `global` | everyone using the app | always joined |
| `region:use1b` | same region/AZ — "the server" in player speak | segment 2 of the shard id |
| `shard:pub_use1b_12326004_040` | same universe instance — people you can actually meet | `<Join PU>` / `<Update Shard Id>` log lines |

The **sidecar** (`src/chat.ts`) holds the one socket per app and fans out to the Chat widget
over SSE. No socket exists unless the widget is open.

> A Centrifugo arm was A/B-tested on 2026-08-08 and retired the same day — same product work
> either way, one more service to run, and it needed a local-echo workaround. The adapter
> lives in git history if ever wanted.

## Running

```
npm run chat-server          # ws://127.0.0.1:8788/ws
```

- `CHAT_AUTH=dev` (default): the client's `hello.handle` is trusted. **Local testing only.**
- `CHAT_AUTH=site`: resolves the overlay sync token via `CHAT_AUTH_URL`
  (default `https://subliminal.gg/api/sc/chat-auth`). Expected reply: `{ handle, verified }`;
  non-verified accounts are refused. **This is the production mode — chat requires an
  RSI-verified account so identities are bannable.**
- `CHAT_PORT` (default 8788).
- Bans: `POST 127.0.0.1:8788/admin/ban {"handle":"..."}` (loopback-only), persisted to
  `data/bans.json`. `/admin/unban`, `GET /admin/bans`.
- History is in-memory (ring of 200/room); the region/shard rooms are ephemeral by nature
  (shards churn every patch), global scrollback resets on restart. Postgres persistence is
  future site-side work.

## Moderation

Reports and auto-moderation both feed one outbound link to the portal on subliminal.gg.

🔴 **This server only ever dials OUT.** Every `/admin/*` route is loopback-gated because an
endpoint that acts with authority *is* the authority, so moderation is never reachable from the
internet — not even behind a token. Events are PUSHED and pending actions are PULLED. The public
attack surface is unchanged by any of it.

| env | default | what it does |
|---|---|---|
| `AUTOMOD_MODE` | `censor` | `off` · `censor` (both lists mask, nobody banned) · `on` (ban tier bans) |
| `AUTOMOD_BAN_LIST` | `chat-server/wordlist-ban.txt` | slurs + hate speech → refuse the message, ban |
| `AUTOMOD_CENSOR_LIST` | `chat-server/wordlist-censor.txt` | profanity → asterisk it, deliver the message |
| `REPORT_WEBHOOK_URL` | — | where report / auto-ban events are POSTed |
| `MOD_ACTION_URL` | — | the portal's ban/unban queue, polled and acked |
| `MOD_SHARED_SECRET` | — | `Authorization: Bearer` on both. **Unset ⇒ the whole link is off** |
| `MOD_POLL_MS` | `20000` | how often the queue is drained |

Every one of them is optional, and every default is the behaviour that existed before the
feature: no list means no auto-moderation, no URL means no push, no secret means no link.

🔴 **TWO LISTS, TWO ANSWERS — Sub's policy, 2026-08-11:** *"I'm worried about racial slurs, hate
speech, that type of stuff. As far as the auto mod banning someone. Otherwise, I really don't care
if an adult uses profanity amongst other adults… we could just censor it."* So `wordlist-ban.txt`
is slurs and hate speech only and gets a ban; `wordlist-censor.txt` is profanity and gets
asterisked in place with the message delivered. A term in **neither** file fires nowhere.

🔴 **`escort` is in neither list, and that is the rule the whole design came from.** It was on the
published LDNOOBW list, it is an SC mission type, and *"need an escort"* is close to the
most-typed sentence in an LFG channel. 23 more ordinary words were pulled out for the same reason
(`hardcore`, `sexy`, `sucks`, `poof`, `how to kill`, …) — each one is listed in the censor file's
header with its reason. **If another turns out to be SC vocabulary, DELETE it rather than moving
it: a censored mission word is a bug, not a milder ban.** All of this is asserted in
`automod.test.mjs` against real SC sentences.

🔑 **Ordinary profanity is COUNTED, never announced** (`/admin/health` → `automod.masked`). One
mod-channel event per "shit" and the reports that matter get scrolled past. A ban-list term in
`censor` mode *does* report, because that is a slur somebody said.

🔑 **Queued actions are delivered at least once** — an action applied but not acked comes back on
the next poll — so `ban` and `unban` are both idempotent no-ops the second time.

## Tests

`node chat-server/automod.test.mjs` (the matcher, offline) · `node chat-server/server.test.mjs`
(protocol, including the moderation link end-to-end against a stub portal) ·
`npx tsx src/chat.test.ts` (the sidecar client against a real spawned server) ·
`npm run test:chat` (all three).

⚠️ The channel table and the persistence note at the top of this file are **stale** — the shard
tier was removed in 0.1.42 and scrollback has been in Postgres since then. Not touched here
because it is nothing to do with moderation; see `dev-bp-tracker/references/chat.md` for what is
actually true.
