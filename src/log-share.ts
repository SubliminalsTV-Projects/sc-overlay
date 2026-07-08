// Opt-in log sharing. When enabled (config.shareLogs) and a sync token is set, the
// current Star Citizen Game.log is scrubbed (src/log-scrub) and uploaded to subliminal.gg
// so mission + blueprint parsing can be improved against real sessions. Deduped by the
// scrubbed content's hash so the periodic tick never re-posts an unchanged session.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { scrubGameLog } from "./log-scrub.js";

const SITE = "https://subliminal.gg";
let lastHash = "";

export interface LogShareConfig {
  shareLogs: boolean;
  syncToken: string;
  logPath: string;
}

/** Best-effort: never throws. Uploads only when sharing is on, a token is set, and the
 *  scrubbed content changed since the last upload. */
export async function maybeShareLog(cfg: LogShareConfig, appVersion = ""): Promise<void> {
  try {
    if (!cfg.shareLogs || !cfg.syncToken) return;
    const raw = readFileSync(cfg.logPath, "utf8");
    if (!raw.trim()) return;
    const { text } = scrubGameLog(raw);
    const hash = createHash("sha1").update(text).digest("hex");
    if (hash === lastHash) return;
    const res = await fetch(`${SITE}/api/bp-tracker/logs?v=${encodeURIComponent(appVersion)}`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", Authorization: `Bearer ${cfg.syncToken}` },
      body: text,
    });
    if (res.ok) {
      lastHash = hash;
      console.log(`[log-share] uploaded scrubbed Game.log (${text.length} chars)`);
    } else {
      console.error(`[log-share] upload rejected: ${res.status}`);
    }
  } catch (err) {
    console.error("[log-share] failed:", err);
  }
}
