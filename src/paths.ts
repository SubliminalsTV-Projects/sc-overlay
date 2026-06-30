/**
 * Resolve a bundled asset directory (overlay/, data/) so it works both in dev
 * (tsx, source-relative) and as a `bun build --compile` single-exe, where the
 * folders ship NEXT TO the executable.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

export function assetDir(metaUrl: string, name: string): string {
  // Dev / normal run: <repo>/<name>, relative to the compiled module in src.
  try {
    const srcParent = join(dirname(fileURLToPath(metaUrl)), "..", name);
    if (existsSync(srcParent)) return srcParent;
  } catch {
    /* compiled binary: import.meta.url isn't a real file path */
  }
  // Packaged: <exe dir>/<name>, shipped alongside the binary.
  const exeParent = join(dirname(process.execPath), name);
  if (existsSync(exeParent)) return exeParent;
  // Last resort: cwd-relative.
  return join(process.cwd(), name);
}
