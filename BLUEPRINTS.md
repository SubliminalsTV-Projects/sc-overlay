# Mission & Blueprint Tracker

A live overlay that shows the **blueprint reward pool** of the Star Citizen mission you're
currently tracking, and checks off the ones you've collected. Built on the same `game.log`
watcher as the loadout overlay.

The log tells us which contract you're tracking and which blueprints you *receive*, but
never the full pool — so the pool comes from a bundled per-patch dataset exported from the
sc-api game database (see [`data/README.md`](data/README.md)).

## Run it

```bash
npm install
npm run overlay        # starts the server on :8778 (loadout + blueprints)
```

Then:

- **OBS / stream** — add a Browser Source pointing at `http://localhost:8778/missions.html`
  (transparent; size ~400×720).
- **Solo / second monitor** — `npm run standalone` opens it in its own app window.

It auto-detects the running patch from the log and loads the matching dataset (falling back
to the newest bundled one). Track a mission in-game and its pool appears; blueprints you've
received check off automatically. **Click any blueprint to manually toggle owned** — useful
to seed ones you earned before installing the tracker (the log can't read your full account
inventory; it only sees what you receive while it's running). State persists in
`%APPDATA%/sc-blueprint-tracker/`.

## Ship it (portable, for other players)

```bash
npm run package        # -> dist/sc-blueprint-tracker.exe + dist/overlay + dist/data
```

Distribute the whole `dist/` folder. End users double-click the exe — it starts the local
server and opens the blueprint window. OBS users add the `localhost:8778/missions.html`
source. No Node, no Electron, no install.

## Updating data each patch (homelab)

The bundled datasets are generated from the self-hosted sc-api:

```bash
tools/build-blueprint-data.sh    # regenerate data/blueprints.<changelist>.json
```

Optionally set `remoteBaseUrl` on the `MissionTracker` to a public dataset endpoint so the
app pulls new patches without re-shipping (offline-first; always falls back to bundled).

## Pieces

| File | Role |
|---|---|
| `src/missions-parser.ts` | extract accept / tracked-marker / completion / received-blueprint from the log |
| `src/missions.ts` | state engine: tracked mission → pool, collected (observed + manual), variant matching, persistence, patch self-detect |
| `overlay/missions.html` | the diegetic HUD panel |
| `src/overlay-server.ts` | serves `/missions.html`, `/missions/events` (SSE), `/api/missions`, `/api/missions/own` |
| `src/standalone.ts` | desktop launcher (server + app-mode window) |
| `data/` + `tools/build-blueprint-data.*` | per-patch blueprint pool datasets + generator |

### Dev tools

```bash
npm run missions-dump   -- "<path to Game.log>"   # print the parsed mission/blueprint timeline
npm run missions-replay -- "<path to Game.log>"   # replay through the tracker, print final pool view
```
