#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: alpha19-linux-sidecar-compat.py WORK_DIR")

p = Path(sys.argv[1]) / "src/overlay-server.ts"
s = p.read_text()
old = 'const userDir = join(process.env.APPDATA ?? process.env.HOME ?? ".", "sc-blueprint-tracker");'
new = 'const userDir = process.env.SC_TRACKER_CONFIG_DIR || join(process.env.APPDATA ?? process.env.HOME ?? ".", "sc-blueprint-tracker");'
if new not in s:
    if old not in s:
        raise SystemExit("0.1.42 sidecar userDir anchor changed")
    s = s.replace(old, new, 1)
p.write_text(s)
print("[alpha19-linux] sidecar honors SC_TRACKER_CONFIG_DIR; upstream 0.1.42 routing/security unchanged")
