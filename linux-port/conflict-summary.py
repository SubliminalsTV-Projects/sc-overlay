#!/usr/bin/env python3
from pathlib import Path
import re

root = Path('linux-port/debug-alpha18')
for p in sorted(root.rglob('*')):
    if not p.is_file():
        continue
    text=p.read_text(errors='replace')
    if '<<<<<<< ' not in text:
        continue
    lines=text.splitlines(); i=0; n=0
    while i < len(lines):
        if not lines[i].startswith('<<<<<<< '):
            i += 1; continue
        n += 1; start=i+1; i += 1; ours=[]; base=[]; theirs=[]
        while i < len(lines) and not lines[i].startswith('||||||| '): ours.append(lines[i]); i+=1
        i += 1
        while i < len(lines) and lines[i] != '=======': base.append(lines[i]); i+=1
        i += 1
        while i < len(lines) and not lines[i].startswith('>>>>>>> '): theirs.append(lines[i]); i+=1
        i += 1
        def sig(part):
            keep=[]
            for x in part:
                y=x.strip()
                if not y or y.startswith('//') or y.startswith('/*') or y.startswith('*') or y.startswith('*/'):
                    continue
                keep.append(y)
            if len(keep) <= 8: return keep
            return keep[:5] + ['…'] + keep[-3:]
        print(f'### {p.relative_to(root)} conflict {n} @ line {start}')
        print('OURS:')
        for x in sig(ours): print('  '+x)
        print('THEIRS:')
        for x in sig(theirs): print('  '+x)
