#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 4:
    raise SystemExit("usage: alpha18-upstream-feature-fixes.py WORK_DIR UPSTREAM_DIR ALPHA17_APP_DIR")
work = Path(sys.argv[1])

main = work / "electron/main.cjs"
s = main.read_text()

# Upstream 0.1.41's adaptive cursor poll emits overlay:cursor-away when the pointer leaves every
# interactive rectangle. Linux deliberately does not use that poller: its renderer-classified
# region probe / Gamescope-to-host pointer handoff is the authoritative hit test. Preserve the same
# public renderer contract at the semantic equivalent transition instead of reviving a second
# cursor ownership model.
away_send = 'overlay?.webContents.send("overlay:cursor-away")'
if away_send not in s:
    old = '''  } else {
    console.log(`[f-hover] left overlay widget classification; click-through restored (${source})`);
    if (wasOverWidget && !moveMode && !modalOpen && !notepadEditing && !dragging) {
      setTimeout(restoreLinuxPreviousWindow, 30);
    }
  }
'''
    new = '''  } else {
    console.log(`[f-hover] left overlay widget classification; click-through restored (${source})`);
    if (wasOverWidget) {
      try { overlay?.webContents.send("overlay:cursor-away"); } catch { /* renderer gone */ }
    }
    if (wasOverWidget && !moveMode && !modalOpen && !notepadEditing && !dragging) {
      setTimeout(restoreLinuxPreviousWindow, 30);
    }
  }
'''
    if old not in s:
        raise SystemExit("upstream feature repair: Linux leave-classification seam missing")
    s = s.replace(old, new, 1)
if s.count('overlay?.webContents.send("overlay:cursor-away")') != 1:
    raise SystemExit("upstream feature repair: cursor-away emitter must be unique")
main.write_text(s)

pre = work / "electron/preload.cjs"
p = pre.read_text()
api_line = '  onCursorAway: (cb) => ipcRenderer.on("overlay:cursor-away", () => cb()),\n'
if api_line not in p:
    anchor = '  onSummonCog: (cb) => ipcRenderer.on("overlay:summon-cog", () => cb()),\n'
    if anchor not in p:
        raise SystemExit("upstream feature repair: preload summon-cog anchor missing")
    comment = '''  // Linux emits this from its classified-region pointer state instead of upstream's desktop poll.
  // The renderer contract stays identical: hide touched/revealed chrome once the pointer is away.
'''
    p = p.replace(anchor, anchor + comment + api_line, 1)
if p.count('onCursorAway:') != 1:
    raise SystemExit("upstream feature repair: preload onCursorAway property must be unique")
pre.write_text(p)

print("[alpha18-upstream-feature] cursor-away renderer contract restored through Linux classifier")
