import { LogWatcher } from "./watcher.js";

/**
 * Default Star Citizen log location. Override with the SC_LOG_PATH env var,
 * e.g.  SC_LOG_PATH="D:\\...\\game.log" npm run start
 */
const DEFAULT_LOG_PATH =
  "C:\\Program Files\\Roberts Space Industries\\StarCitizen\\GAME\\game.log";

const logPath = process.env.SC_LOG_PATH ?? DEFAULT_LOG_PATH;

const watcher = new LogWatcher(logPath, {
  pollInterval: 500,
  readExisting: false, // tail new lines only; flip to true to replay the current session
});

watcher.on("appear", () => console.log(`[watcher] found log: ${logPath}`));
watcher.on("rotate", () => console.log("[watcher] new session (log rotated)"));
watcher.on("error", (err) => console.error("[watcher] read error:", err.message));

watcher.on("event", (e) => {
  const ts = e.timestamp ?? "--";
  const sev = e.severity ? `[${e.severity}]` : "";
  const tag = e.eventTag ? `<${e.eventTag}>` : "";
  const tags = e.tags.length ? ` ${e.tags.map((t) => `#${t}`).join(" ")}` : "";
  console.log(`${ts} ${sev}${tag} ${e.message}${tags}`.trim());
});

watcher.start();
console.log(`[watcher] watching ${logPath} (Ctrl+C to stop)`);

process.on("SIGINT", () => {
  watcher.stop();
  console.log("\n[watcher] stopped");
  process.exit(0);
});
