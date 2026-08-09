#!/usr/bin/env python3
from pathlib import Path
import re
import shutil
import sys
import tarfile
import tempfile

run_temp = Path(__import__('os').environ.get('RUNNER_TEMP', '/tmp'))
work = run_temp / 'r31-alpha18-build' / 'work'
tar_path = run_temp / 'dist' / 'ArchVerse-Overlay-0.1.41-r31-alpha.18-arch.tar.gz'
if not (work / 'electron/main.cjs').exists():
    raise SystemExit('[ipc-audit] generated main.cjs missing')
if not tar_path.exists():
    raise SystemExit('[ipc-audit] package tarball missing')


def audit(app_root: Path, label: str):
    electron = app_root / 'electron'
    main = (electron / 'main.cjs').read_text(errors='replace')
    handles = set(re.findall(r'ipcMain\.handle\(\s*["\']([^"\']+)', main))
    listeners = set(re.findall(r'ipcMain\.(?:on|once)\(\s*["\']([^"\']+)', main))
    bad = []
    for preload_name in ('preload.cjs', 'config-preload.cjs', 'mining-preload.cjs'):
        p = electron / preload_name
        if not p.exists():
            continue
        src = p.read_text(errors='replace')
        invokes = set(re.findall(r'ipcRenderer\.invoke\(\s*["\']([^"\']+)', src))
        sends = set(re.findall(r'ipcRenderer\.send\(\s*["\']([^"\']+)', src))
        for channel in sorted(invokes - handles):
            bad.append(f'{preload_name}: invoke({channel}) has no ipcMain.handle')
        for channel in sorted(sends - listeners):
            bad.append(f'{preload_name}: send({channel}) has no ipcMain.on/once')
    if bad:
        print(f'[ipc-audit] {label} contract failures:', file=sys.stderr)
        for line in bad:
            print('  ' + line, file=sys.stderr)
        raise SystemExit(60)
    print(f'[ipc-audit] {label}: preload → main IPC contract PASS')


audit(work, 'work tree')
with tempfile.TemporaryDirectory(prefix='alpha18-ipc-') as td:
    td = Path(td)
    with tarfile.open(tar_path, 'r:gz') as tf:
        tf.extractall(td)
    roots = [p for p in td.iterdir() if p.is_dir()]
    if len(roots) != 1 or not (roots[0] / 'app/electron/main.cjs').exists():
        raise SystemExit('[ipc-audit] packaged app root not recognized')
    audit(roots[0] / 'app', 'package')
