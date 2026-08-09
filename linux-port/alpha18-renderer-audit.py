#!/usr/bin/env python3
from __future__ import annotations
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
import json
import os
import re
import subprocess
import sys
import tarfile
import tempfile

run_temp = Path(os.environ.get('RUNNER_TEMP', '/tmp'))
work = run_temp / 'r31-alpha18-build' / 'work'
tar_path = run_temp / 'dist' / 'ArchVerse-Overlay-0.1.41-r31-alpha.18-arch.tar.gz'
if not (work / 'overlay').is_dir():
    raise SystemExit('[renderer-audit] generated overlay directory missing')
if not tar_path.exists():
    raise SystemExit('[renderer-audit] package tarball missing')

class IdParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.ids=[]
    def handle_starttag(self, tag, attrs):
        for k,v in attrs:
            if k.lower() == 'id' and v:
                self.ids.append(v)

SCRIPT_RE = re.compile(r'<script\b([^>]*)>(.*?)</script\s*>', re.I|re.S)
ATTR_RE = re.compile(r'([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+)))?', re.S)

def attrs(text: str) -> dict[str,str]:
    out={}
    for m in ATTR_RE.finditer(text):
        out[m.group(1).lower()] = next((x for x in m.groups()[1:] if x is not None), '')
    return out

def audit_overlay(root: Path, label: str):
    bad=[]
    htmls=sorted(root.glob('*.html'))
    if not htmls:
        raise SystemExit(f'[renderer-audit] {label}: no HTML files found')
    with tempfile.TemporaryDirectory(prefix='alpha18-renderer-js-') as td_s:
        td=Path(td_s)
        for html in htmls:
            text=html.read_text(errors='replace')
            parser=IdParser()
            try: parser.feed(text)
            except Exception as e: bad.append(f'{html.name}: HTML parser failure: {e!r}')
            duplicates=[(k,n) for k,n in Counter(parser.ids).items() if n>1]
            for key,n in duplicates:
                bad.append(f'{html.name}: duplicate DOM id {key!r} x{n}')

            seq=0
            for m in SCRIPT_RE.finditer(text):
                at=attrs(m.group(1)); body=m.group(2)
                if 'src' in at: continue
                typ=at.get('type','').strip().lower()
                if typ in {'application/json','application/ld+json','importmap'}: continue
                if not body.strip(): continue
                seq += 1
                suffix='.mjs' if typ == 'module' else '.js'
                js=td/f'{label.replace("/","-")}-{html.stem}-{seq}{suffix}'
                js.write_text(body)
                r=subprocess.run(['node','--check',str(js)], text=True, capture_output=True)
                if r.returncode:
                    bad.append(f'{html.name}: inline script {seq} syntax failed:\n{r.stderr.strip()}')

        # JSON files served to renderers are easy conflict casualties too.
        for j in sorted(root.glob('*.json')):
            try: json.loads(j.read_text())
            except Exception as e: bad.append(f'{j.name}: invalid JSON: {e!r}')
    if bad:
        print(f'[renderer-audit] {label} failures:', file=sys.stderr)
        for x in bad: print('  '+x.replace('\n','\n    '), file=sys.stderr)
        raise SystemExit(90)
    print(f'[renderer-audit] {label}: {len(htmls)} HTML files, inline JS, DOM IDs, JSON PASS')

audit_overlay(work/'overlay', 'work')
with tempfile.TemporaryDirectory(prefix='alpha18-renderer-package-') as td_s:
    td=Path(td_s)
    with tarfile.open(tar_path, 'r:gz') as tf: tf.extractall(td)
    roots=[p for p in td.iterdir() if p.is_dir()]
    if len(roots)!=1:
        raise SystemExit('[renderer-audit] package root not recognized')
    overlay=roots[0]/'app/server/overlay'
    if not overlay.is_dir():
        raise SystemExit('[renderer-audit] packaged server overlay missing')
    audit_overlay(overlay, 'package')
