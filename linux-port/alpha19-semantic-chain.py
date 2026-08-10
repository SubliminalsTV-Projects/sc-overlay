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

# Alpha18's merge sometimes swallowed the close of overlay:canvas-info. Upstream 0.1.42 changed
# the neighbouring main-process block and its three-way result can already contain a valid close.
# Repair the known-bad form, but otherwise verify structure instead of requiring one exact seam.
old = '''if canvas_close_bad not in s:
    raise SystemExit("main: canvas-info close seam missing")
s = s.replace(canvas_close_bad, canvas_close_good, 1)
'''
new = '''if canvas_close_bad in s:
    s = s.replace(canvas_close_bad, canvas_close_good, 1)
else:
    ci = s.find('ipcMain.handle("overlay:canvas-info"')
    hm = s.find('ipcMain.handle("app:set-hold-mode"', ci + 1) if ci >= 0 else -1
    if ci < 0 or hm < 0 or '});' not in s[ci:hm]:
        raise SystemExit("main: canvas-info handler is not structurally closed before app:set-hold-mode")
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
