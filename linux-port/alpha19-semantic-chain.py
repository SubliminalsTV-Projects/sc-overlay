#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys
import tempfile

if len(sys.argv) != 4:
    raise SystemExit("usage: alpha19-semantic-chain.py WORK_DIR UPSTREAM_DIR ALPHA17_APP_DIR")

root = Path(__file__).resolve().parent
args = sys.argv[1:]
src = (root / "alpha18-semantic-repair.py").read_text()

# Alpha18's merge sometimes damaged only overlay:canvas-info. Upstream 0.1.42 changed this IPC
# neighbourhood enough that diff3 can now lose the adjacent hold/foreground handlers too. Treat the
# whole cluster as one semantic unit: upstream owns its IPC/API shape; ArchVerse's Linux focus/input
# implementation is layered underneath by the later post-repair/runtime stages.
old = '''if canvas_close_bad not in s:
    raise SystemExit("main: canvas-info close seam missing")
s = s.replace(canvas_close_bad, canvas_close_good, 1)
'''
new = '''cluster_start = '  ipcMain.handle("overlay:canvas-info"'
mi = s.find(cluster_start)
ui = up_main.find(cluster_start)
if mi < 0 or ui < 0:
    raise SystemExit("main: canvas interaction IPC cluster start missing")
end_anchors = [
    '  ipcMain.on("overlay:hover"',
    '  ipcMain.on("overlay:regions"',
    '  ipcMain.on("overlay:modal"',
]
chosen = None
mj = uj = -1
for anchor in end_anchors:
    a = s.find(anchor, mi + len(cluster_start))
    b = up_main.find(anchor, ui + len(cluster_start))
    if a >= 0 and b >= 0:
        chosen, mj, uj = anchor, a, b
        break
if chosen is None:
    raise SystemExit("main: no stable end anchor after canvas interaction IPC cluster")
up_cluster = up_main[ui:uj]
s = s[:mi] + up_cluster + s[mj:]
'''
if old not in src:
    raise SystemExit("alpha19 semantic adapter: Alpha18 canvas seam block changed")
src = src.replace(old, new, 1)

with tempfile.TemporaryDirectory(prefix="alpha19-semantic-") as td:
    patched = Path(td) / "semantic-repair.py"
    patched.write_text(src)
    subprocess.run([sys.executable, str(patched), *args], check=True)

# Reuse the audited normalization layers after the 0.1.42-aware primary reconstruction.
for script in [
    "alpha18-semantic-postrepair.py",
    "alpha18-lexical-fixes.py",
    "alpha18-scan-diagnostics.py",
    "alpha18-upstream-feature-fixes.py",
    "alpha18-field-runtime-fixes.py",
]:
    subprocess.run([sys.executable, str(root / script), *args], check=True)

print("[alpha19-semantic] 0.1.42-aware semantic reconstruction chain PASS")
