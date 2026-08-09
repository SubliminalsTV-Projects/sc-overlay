#!/usr/bin/env python3
from pathlib import Path
import subprocess
import sys

if len(sys.argv) != 4:
    raise SystemExit("usage: alpha18-semantic-chain.py WORK_DIR UPSTREAM_DIR ALPHA17_APP_DIR")
root = Path(__file__).resolve().parent
args = sys.argv[1:]
subprocess.run([sys.executable, str(root / "alpha18-semantic-repair.py"), *args], check=True)
subprocess.run([sys.executable, str(root / "alpha18-semantic-postrepair.py"), *args], check=True)
subprocess.run([sys.executable, str(root / "alpha18-lexical-fixes.py"), *args], check=True)
subprocess.run([sys.executable, str(root / "alpha18-scan-diagnostics.py"), *args], check=True)
subprocess.run([sys.executable, str(root / "alpha18-upstream-feature-fixes.py"), *args], check=True)
subprocess.run([sys.executable, str(root / "alpha18-field-runtime-fixes.py"), *args], check=True)
