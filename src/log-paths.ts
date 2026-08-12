/**
 * Which log files "Verify from logs" should scan, given the configured game.log path.
 *
 * Extracted from the verify route so it can be tested against BOTH real-world layouts. It has to
 * be correct for the ordinary install (LIVE / PTU / EPTU as separate real directories, each with
 * its own logs — every one of them must still be scanned) AND for the install where those names
 * are links to a single folder, where the same physical log would otherwise be scanned once per
 * link. Sub has the second kind and most people have the first, so neither can be a special case.
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** The canonical on-disk identity of a path, for deciding whether two paths are the same file.
 *  Falls back to the path as written when it can't be resolved — a link we can't follow is still
 *  better scanned than dropped. */
function identity(p: string): string {
  try {
    // `.native` asks the OS, which is what follows junctions AND symlinks on Windows; if this
    // build somehow lacks it, the TypeError lands in the catch and we degrade to the plain path.
    return realpathSync.native(p).toLowerCase();
  } catch {
    return p.toLowerCase();
  }
}

/**
 * Every live-log candidate under the configured channel and its siblings, deduplicated by the
 * file each path actually resolves to.
 *
 * 🔑 Siblings are scanned on purpose: a player with separate LIVE and PTU installs is pointed at
 * whichever they launched last, so their whole LIVE history can sit unscanned in a sibling folder.
 * That is safe because the environment gate reads each log's own header rather than trusting the
 * folder name — a renamed channel can neither hide a live log nor smuggle in a test one.
 */
export function collectLogPaths(configuredLogPath: string): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  const addLog = (p: string): void => {
    if (!existsSync(p)) return;
    const k = identity(p);
    if (seen.has(k)) return;
    seen.add(k);
    paths.push(p);
  };
  const addChannel = (dir: string): void => {
    addLog(join(dir, "game.log"));
    try {
      const backups = join(dir, "logbackups");
      for (const f of readdirSync(backups)) {
        if (f.toLowerCase().endsWith(".log")) addLog(join(backups, f));
      }
    } catch {
      /* no logbackups dir for this channel */
    }
  };
  if (!configuredLogPath) return paths;
  addChannel(dirname(configuredLogPath)); // the configured channel first
  try {
    const root = dirname(dirname(configuredLogPath)); // …/StarCitizen — its children are channels
    for (const ch of readdirSync(root)) addChannel(join(root, ch));
  } catch {
    /* unusual layout — the configured channel alone still works */
  }
  return paths;
}
