#!/usr/bin/env python3
from pathlib import Path
import re
import sys

if len(sys.argv) != 4:
    raise SystemExit("usage: alpha18-field-runtime-fixes.py WORK_DIR UPSTREAM_DIR ALPHA17_APP_DIR")

work = Path(sys.argv[1])
main = work / "electron/main.cjs"
s = main.read_text()

# -----------------------------------------------------------------------------
# 1. Linux installs are deliberately UNPACKED and launched by the system Electron.
# -----------------------------------------------------------------------------
# Electron therefore reports app.isPackaged === false even though ArchVerse is a production
# install. Upstream 0.1.41 used app.isPackaged to select server.mjs vs `npx tsx`, which made the
# installed Linux build take the developer path and leave :8778 dead. Production-ness on Linux is
# defined by the bundled server actually being present, not Electron's packaging bit.
if "function bundledServerJsPath()" not in s:
    anchor = "function startServer() {\n"
    helper = '''function bundledServerJsPath() {
  const candidates = [path.join(ROOT, "server", "server.mjs")];
  if (typeof process.resourcesPath === "string" && process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, "server", "server.mjs"),
      path.join(process.resourcesPath, "app", "server", "server.mjs"),
    );
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

'''
    if anchor not in s:
        raise SystemExit("field fix: startServer anchor missing")
    s = s.replace(anchor, helper + anchor, 1)

start = s.find("function startServer() {")
end = s.find("\n/** Everything the app does happens in the sidecar", start)
if start < 0 or end < 0:
    raise SystemExit("field fix: server lifecycle boundaries missing")
server_block = s[start:end]

if "const bundledServerJs = bundledServerJsPath();" not in server_block:
    old = '  if (app.isPackaged) {\n'
    new = '''  const bundledServerJs = bundledServerJsPath();
  if (bundledServerJs) {
'''
    if old not in server_block:
        raise SystemExit("field fix: app.isPackaged sidecar gate missing")
    server_block = server_block.replace(old, new, 1)

old_server_path = '    const serverJs = path.join(process.resourcesPath, "server", "server.mjs");\n'
if old_server_path in server_block:
    server_block = server_block.replace(old_server_path, '    const serverJs = bundledServerJs;\n', 1)
elif '    const serverJs = bundledServerJs;\n' not in server_block:
    raise SystemExit("field fix: bundled server path assignment missing")

# The dev path must remain available for actual source-tree development, but a production Linux
# install with app/server/server.mjs must never reach it.
s = s[:start] + server_block + s[end:]

# -----------------------------------------------------------------------------
# 2. F-latched interaction: transparent canvas is an explicit RELEASE surface.
# -----------------------------------------------------------------------------
# Alpha16's physical click-forwarding correctly refuses to inject clicks into empty canvas, but it
# accidentally replaced r20's focus-release behavior with a no-op. The result is a 6360x2160
# focused Electron input blocker: every attempt to click back to Star Citizen logs "ignored outside
# a classified widget" and the underlying window never gets a chance to regain focus.
old_outside = '''  if (phase === "down" && !region) {
    console.log(`[f-click] ${button} down ignored outside a classified widget at ${Math.round(globalPoint.x)},${Math.round(globalPoint.y)}`);
    return;
  }
'''
new_outside = '''  if (phase === "down" && !region) {
    if (overlayInteractionLatched && !fHoverHeld && !modalOpen && !moveMode && !notepadEditing && !dragging) {
      console.log(`[focus-latch] ${button} down on transparent canvas at ${Math.round(globalPoint.x)},${Math.round(globalPoint.y)}; releasing overlay interaction`);
      // Deliberately do NOT replay this click into the game. This preserves the proven r20 safety
      // contract: the first empty-canvas click returns focus/click-through; subsequent input belongs
      // to Star Citizen or whichever external application the user chooses.
      releaseFocusLatchToGame("transparent canvas clicked");
    } else {
      console.log(`[f-click] ${button} down ignored outside a classified widget at ${Math.round(globalPoint.x)},${Math.round(globalPoint.y)}`);
    }
    return;
  }
'''
if old_outside in s:
    s = s.replace(old_outside, new_outside, 1)
elif "down on transparent canvas" not in s:
    raise SystemExit("field fix: outside-click forwarding seam missing")

# -----------------------------------------------------------------------------
# 3. Startup What's New modal must return native focus when it closes.
# -----------------------------------------------------------------------------
# The modal intentionally focuses the Overlay Manager so it can be clicked without F. Before doing
# that, capture the current external window. On close, once the canvas is click-through again,
# restore that captured window. Without both halves Electron can remain the keyboard focus owner
# even though the modal disappeared.
modal_pattern = re.compile(
    r'  ipcMain\.on\("overlay:modal", \(_e, on\) => \{\n(?P<body>.*?)\n  \}\);',
    re.S,
)
m = modal_pattern.search(s)
if not m:
    raise SystemExit("field fix: overlay:modal handler missing")
body = m.group("body")
if "captureLinuxActiveWindow();" not in body:
    old_focus = '    if (modalOpen) setTimeout(() => focusLinuxInteractiveWindow("overlay"), 0);'
    if old_focus not in body:
        raise SystemExit("field fix: modal focus anchor missing")
    new_focus = '''    if (modalOpen) {
      if (process.platform === "linux") captureLinuxActiveWindow();
      setTimeout(() => focusLinuxInteractiveWindow("overlay"), 0);
    } else if (process.platform === "linux" && !overlayInteractionLatched && !momentaryInteractionActive
               && !moveMode && !notepadEditing && !dragging) {
      // applyMouse/reapply above already restored whole-window click-through; now return keyboard
      // focus to the window that was active before the modal appeared.
      setTimeout(restoreLinuxPreviousWindow, 30);
    }'''
    body = body.replace(old_focus, new_focus, 1)
    s = s[:m.start("body")] + body + s[m.end("body"):]

# Hard invariants: these are the three field failures this pass exists to prevent.
server_start = s.find("function startServer() {")
server_end = s.find("\n/** Everything the app does happens in the sidecar", server_start)
server_block = s[server_start:server_end]
if 'if (app.isPackaged) {' in server_block:
    raise SystemExit("field fix: production sidecar still depends on app.isPackaged")
for token in [
    "function bundledServerJsPath()",
    'path.join(ROOT, "server", "server.mjs")',
    "const bundledServerJs = bundledServerJsPath();",
    "const serverJs = bundledServerJs;",
    'releaseFocusLatchToGame("transparent canvas clicked")',
    "down on transparent canvas",
    "if (process.platform === \"linux\") captureLinuxActiveWindow();",
    "setTimeout(restoreLinuxPreviousWindow, 30);",
]:
    if token not in s:
        raise SystemExit(f"field fix: required runtime invariant missing: {token}")

main.write_text(s)
print("[alpha18-field-runtime] unpacked sidecar + transparent-canvas focus release + modal focus restore PASS")
