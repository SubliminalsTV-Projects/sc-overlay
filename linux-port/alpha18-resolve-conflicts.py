#!/usr/bin/env python3
from pathlib import Path
import sys

root = Path(sys.argv[1])
files = [
    root / "electron/main.cjs",
    root / "electron/capture.cjs",
    root / "electron/preload.cjs",
    root / "overlay/config.html",
    root / "overlay/missions.html",
    root / "overlay/mining.html",
]

def resolve_union(text: str) -> tuple[str, int]:
    out=[]; lines=text.splitlines(keepends=True); i=0; n=0
    while i < len(lines):
        if not lines[i].startswith("<<<<<<< "):
            out.append(lines[i]); i += 1; continue
        n += 1; i += 1; ours=[]; base=[]; theirs=[]
        while i < len(lines) and not lines[i].startswith("||||||| "):
            ours.append(lines[i]); i += 1
        if i >= len(lines): raise SystemExit("malformed conflict: missing base marker")
        i += 1
        while i < len(lines) and not lines[i].startswith("======="):
            base.append(lines[i]); i += 1
        if i >= len(lines): raise SystemExit("malformed conflict: missing separator")
        i += 1
        while i < len(lines) and not lines[i].startswith(">>>>>>> "):
            theirs.append(lines[i]); i += 1
        if i >= len(lines): raise SystemExit("malformed conflict: missing end marker")
        i += 1
        # Keep both edited sides, but collapse exact duplicate lines at the seam. This is only the
        # first pass; syntax/tests decide which overlapping blocks need a hand-written semantic rule.
        combined = ours[:]
        if combined and theirs and combined[-1] == theirs[0]:
            combined.extend(theirs[1:])
        else:
            combined.extend(theirs)
        out.extend(combined)
    return "".join(out), n

for p in files:
    if not p.exists(): continue
    s=p.read_text()
    if "<<<<<<< " not in s: continue
    r,count=resolve_union(s)
    p.write_text(r)
    print(f"[alpha18-resolve] union-resolved {count} block(s) in {p.relative_to(root)}")
