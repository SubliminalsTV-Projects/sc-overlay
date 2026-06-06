/**
 * Auto-switch agent (runs on the gaming PC).
 *
 * Tails game.log, detects which ship you're flying, and tells the subliminal.gg
 * EBS to make that ship's saved loadout the active one — so the overlay switches
 * automatically and you never touch the OBS source or the Twitch config.
 *
 *   npm run agent
 *
 * Config (env):
 *   SC_OVERLAY_SECRET   (required) the SC_LOADOUT_AGENT_SECRET from Vercel.
 *   SC_OVERLAY_EBS      base URL (default https://subliminal.gg).
 *   SC_LOG_PATH         path to game.log (default = the LIVE install path).
 *   SC_PLAYER_HANDLE    (optional) your RSI handle; when set, only YOUR ship's
 *                       comms-channel joins trigger a switch (ignores teammates').
 *
 * Why this and not the loadout itself: game.log never logs a ship's components —
 * only WHICH ship you're in. The loadout always comes from your saved erkul build;
 * this agent just picks the right build by ship. See the dev-sc-loadout-overlay skill.
 */
import { LogWatcher } from "./watcher.js";
import type { LogEvent } from "./parser.js";

const EBS = (process.env.SC_OVERLAY_EBS || "https://subliminal.gg").replace(/\/+$/, "");
const SECRET = process.env.SC_OVERLAY_SECRET || "";
const LOG_PATH =
  process.env.SC_LOG_PATH ||
  "C:\\Program Files\\Roberts Space Industries\\StarCitizen\\LIVE\\game.log";
const HANDLE = process.env.SC_PLAYER_HANDLE?.trim() || "";

if (!SECRET) {
  console.error(
    "Missing SC_OVERLAY_SECRET. Set it to the SC_LOADOUT_AGENT_SECRET value from Vercel.",
  );
  process.exit(1);
}

// Own-ship signals (see the skill):
//   PU:  …joined channel '<ShipDisplayName> : <PlayerName>'
//   AC:  …OnVehicleSpawned <id> (<VehicleName>_<n>) by player 0
const PU_JOIN = /joined channel '(.+?)\s*:\s*(.+?)'/;
const AC_SPAWN = /OnVehicleSpawned\s+\d+\s+\(([A-Za-z0-9_]+?)_\d+\)\s+by player 0/;

let lastShip: string | null = null;

async function setActive(ship: string): Promise<void> {
  if (ship === lastShip) return; // debounce: only on change
  lastShip = ship;
  try {
    const res = await fetch(
      `${EBS}/api/sc-loadout/active?secret=${encodeURIComponent(SECRET)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ship }),
      },
    );
    const data = (await res.json().catch(() => ({}))) as {
      matched?: string | null;
    };
    if (res.ok && data.matched) console.log(`[switch] "${ship}" → active`);
    else if (res.ok)
      console.log(`[switch] "${ship}" — no matching saved loadout (ignored)`);
    else console.error(`[switch] "${ship}" → HTTP ${res.status}`);
  } catch (err) {
    console.error(`[switch] "${ship}" failed:`, String(err));
  }
}

function onEvent(e: LogEvent): void {
  const pu = e.message.match(PU_JOIN);
  if (pu) {
    const [, ship, player] = pu;
    if (HANDLE && player.trim().toLowerCase() !== HANDLE.toLowerCase()) return;
    void setActive(ship.trim());
    return;
  }
  const ac = e.message.match(AC_SPAWN);
  if (ac) void setActive(ac[1].replace(/_/g, " ").trim());
}

const watcher = new LogWatcher(LOG_PATH, { pollInterval: 1000 });
watcher.on("event", onEvent);
watcher.on("rotate", () => {
  lastShip = null;
  console.log("[watcher] new game session");
});
watcher.on("appear", () => console.log("[watcher] game.log found"));
watcher.on("error", (err) => console.error("[watcher]", err.message));
watcher.start();

console.log(`SC loadout auto-switch agent → ${EBS}`);
console.log(`watching ${LOG_PATH}${HANDLE ? `  (handle: ${HANDLE})` : ""}`);
