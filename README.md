# SC Log Watcher

Tails the Star Citizen `game.log` and emits structured events. This is the
foundation layer — the watcher core only reads, parses, and emits. Apps
(overlays, dashboards, Discord alerts, etc.) plug in as event handlers.

Zero runtime dependencies — pure Node built-ins.

**Apps built on it:** a ship-loadout overlay (erkul.games), and a **[Mission &
Blueprint Tracker](BLUEPRINTS.md)** that shows the reward pool of the mission you're
tracking and checks off what you've collected.

## Run the demo

```bash
npm install
npm run start      # tails the default log path, prints parsed events
```

Override the log path if your install differs:

```bash
# PowerShell
$env:SC_LOG_PATH="D:\Games\StarCitizen\LIVE\game.log"; npm run start
```

`npm run dev` does the same with auto-reload on source changes.

## Using the watcher in your own app

```ts
import { LogWatcher } from "./src/watcher.js";

const watcher = new LogWatcher(logPath, {
  pollInterval: 500,   // ms between file checks
  readExisting: false, // false = tail new lines only; true = replay current session
});

watcher.on("event", (e) => {
  // e: { raw, timestamp, severity, eventTag, tags, message }
  if (e.eventTag === "Actor Death") {
    // ...do something
  }
});

watcher.on("rotate", () => {/* new game session started */});
watcher.start();
```

### Events

| Event    | Payload          | Meaning                                            |
| -------- | ---------------- | -------------------------------------------------- |
| `event`  | `LogEvent`       | A parsed line.                                     |
| `line`   | `string`         | The same line, unparsed.                           |
| `appear` | —                | The log file came into existence.                  |
| `rotate` | —                | File truncated/replaced — a new session began.     |
| `error`  | `Error`          | Non-fatal read error; polling continues.           |

### Parsed `LogEvent` shape

```
<2026-06-04T01:34:29.449Z> [Notice] <CreateChannel> Opening channel ... [Team_OnlineTech][gRPC]
```

becomes

```ts
{
  raw:       "<2026-...> [Notice] <CreateChannel> Opening channel ... [Team_OnlineTech][gRPC]",
  timestamp: "2026-06-04T01:34:29.449Z",
  severity:  "Notice",
  eventTag:  "CreateChannel",
  tags:      ["Team_OnlineTech", "gRPC"],
  message:   "Opening channel ...",
}
```

All fields except `raw` and `message` are nullable / may be empty — plain lines
(no timestamp, severity, or tag) parse to just a `message`.

## How it handles the log's quirks

- **Rotation:** SC truncates/overwrites `game.log` on every launch. Detected as
  the file shrinking below the read position → reset to 0, emit `rotate`, read
  the new session from the top.
- **Live writes / file lock:** the game holds the file open and writes to it
  continuously. A fresh read handle is opened per poll (shared access), so the
  watcher never fights the lock or holds a stale handle.
- **Partial lines:** a line still being written (no trailing newline yet) is
  buffered and reassembled on the next read.
- **Not launched yet:** if the file doesn't exist, the watcher waits and emits
  `appear` once it shows up.

## Layout

- `src/parser.ts` — `parseLine(raw)` → `LogEvent`. Pure, no I/O.
- `src/watcher.ts` — `LogWatcher`, the tailer + emitter.
- `src/index.ts`  — demo entry point.
