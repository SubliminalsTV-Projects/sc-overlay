/** ArchVerse build-time overlay patches.
 *
 * Upstream keeps missions.html/mining.html as very large single files. Rather than
 * permanently forking those files (and turning every upstream merge into a conflict),
 * the Linux fork copies them unchanged and layers our small extension scripts into the
 * BUILD output. Source remains easy to rebase; the shipped server gets ArchVerse UX.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function rewrite(path, mutate) {
  const before = readFileSync(path, "utf8");
  const after = mutate(before);
  if (after === before) throw new Error(`ArchVerse patch made no change: ${path}`);
  writeFileSync(path, after, "utf8");
}

function appendScript(html, src, marker) {
  if (html.includes(marker)) return html;
  if (!html.includes("</body>")) throw new Error(`Cannot inject ${src}: </body> not found`);
  return html.replace("</body>", `  <!-- ${marker} -->\n  <script src="${src}"></script>\n</body>`);
}

export function applyArchVerseOverlayPatches(outDir) {
  const overlay = join(outDir, "overlay");

  rewrite(join(overlay, "missions.html"), (html) => {
    let next = html.replaceAll("Mining Scanner", "Resource Scanner");
    next = appendScript(next, "/archverse-widget-appearance.js", "ARCHVERSE_WIDGET_APPEARANCE_V1");
    return next;
  });

  rewrite(join(overlay, "mining.html"), (html) => {
    let next = html.replaceAll("Mining Scanner", "Resource Scanner");
    // This is the test-button fallback spoken by the stock handler. The extension
    // replaces normal scan speech, but keeping the test phrase current avoids an old name.
    next = next.replaceAll("Mining assistant ready", "Resource scanner ready");
    next = appendScript(next, "/archverse-resource-scanner.js", "ARCHVERSE_RESOURCE_SCANNER_V1");
    return next;
  });

  // Full settings page: rename visible feature text while retaining internal config
  // keys (`miningAssistant`, `miningHotkey`, etc.) for compatibility.
  rewrite(join(overlay, "config.html"), (html) =>
    html.replaceAll("Mining Scanner", "Resource Scanner").replaceAll("Mining Assistant", "Resource Scanner"));

  console.log("applied ArchVerse Resource Scanner + per-widget appearance patches");
}
