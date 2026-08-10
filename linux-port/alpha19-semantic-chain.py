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

# Alpha18's merge sometimes swallowed only the close of overlay:canvas-info. In 0.1.42 the
# neighbouring main-process block changed enough that the diff3 intermediate can splice pieces from
# both versions into the handler. Do not try to brace-repair that hybrid. Replace the entire handler
# (and its explanatory comments up to app:set-hold-mode) with upstream 0.1.42's coherent block.
# Linux geometry still flows underneath through the ArchVerse virtual-desktop/window-manager
# functions reconstructed elsewhere in main.cjs.
old = '''if canvas_close_bad not in s:
    raise SystemExit("main: canvas-info close seam missing")
s = s.replace(canvas_close_bad, canvas_close_good, 1)
'''
new = '''up_canvas = extract_between(
    up_main,
    '  ipcMain.handle("overlay:canvas-info"',
    '  ipcMain.handle("app:set-hold-mode"',
    label="upstream canvas-info block",
)
s = replace_between(
    s,
    '  ipcMain.handle("overlay:canvas-info"',
    '  ipcMain.handle("app:set-hold-mode"',
    up_canvas,
    label="merged canvas-info block",
)
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
