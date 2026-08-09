#!/usr/bin/env python3
from __future__ import annotations
from pathlib import Path
import os
import re
import sys
import tarfile
import tempfile

run_temp = Path(os.environ.get("RUNNER_TEMP", "/tmp"))
root = run_temp / "r31-alpha18-build"
up = root / "upstream-0.1.41"
work = root / "work"
tar_path = run_temp / "dist" / "ArchVerse-Overlay-0.1.41-r31-alpha.18-arch.tar.gz"

for p, label in [(up, "upstream 0.1.41"), (work, "candidate work tree")]:
    if not p.is_dir():
        raise SystemExit(f"[upstream-contract] {label} missing: {p}")
if not tar_path.exists():
    raise SystemExit("[upstream-contract] candidate package missing")

IPC_RE = re.compile(r'ipcMain\.(handle|on|once)\(\s*["\']([^"\']+)["\']')
PRELOAD_API_RE = re.compile(r'(?m)^\s{2}([A-Za-z_$][\w$]*):\s*')

# A few IPC channels may eventually be intentionally Windows-only or replaced by Linux-native
# interaction ownership. Keep this allowlist explicit and tiny; any new omission must be reviewed
# and added with a reason rather than silently passing.
IPC_ALLOW_MISSING: set[tuple[str, str]] = set()


def ipc_contract(main: str) -> set[tuple[str, str]]:
    return {(kind, channel) for kind, channel in IPC_RE.findall(main)}


def preload_keys(text: str) -> set[str]:
    # electron/preload.cjs exposes one contextBridge object; two-space property indentation is stable
    # and avoids collecting object literals nested inside method bodies.
    return set(PRELOAD_API_RE.findall(text))


def routes(text: str) -> set[tuple[str, str | None]]:
    out: set[tuple[str, str | None]] = set()
    # Route extraction is deliberately conservative. It looks only at literal /api, /events and
    # served-page paths and records a nearby HTTP verb where one is present.
    for m in re.finditer(r'if\s*\(\s*(?:\([^)]*\)\s*&&\s*)?url(?:\?|\.)?', text):
        block = text[m.start():m.start()+420]
        path_m = re.search(r'["\'](/(?:api/[^"\']+|events|missions/events|missions\.html|config\.html|setup\.html))', block)
        if not path_m:
            continue
        method_m = re.search(r'req\.method\s*===\s*["\']([A-Z]+)["\']', block)
        out.add((path_m.group(1).rstrip('?'), method_m.group(1) if method_m else None))
    return out


def audit(candidate_root: Path, label: str):
    up_main = (up / "electron/main.cjs").read_text(errors="replace")
    cand_main = (candidate_root / "electron/main.cjs").read_text(errors="replace")
    upstream_ipc = ipc_contract(up_main)
    candidate_ipc = ipc_contract(cand_main)
    missing_ipc = sorted(upstream_ipc - candidate_ipc - IPC_ALLOW_MISSING)

    up_pre = preload_keys((up / "electron/preload.cjs").read_text(errors="replace"))
    cand_pre = preload_keys((candidate_root / "electron/preload.cjs").read_text(errors="replace"))
    missing_pre = sorted(up_pre - cand_pre)

    # Server source lives in src/ for work/upstream, but in the package only the esbuild server.mjs
    # exists. Route preservation is therefore source-audited in the work tree; package endpoint
    # execution is independently covered by the actual sidecar smoke test.
    missing_routes: list[tuple[str, str | None]] = []
    upstream_routes: set[tuple[str, str | None]] = set()
    if (candidate_root / "src/overlay-server.ts").exists():
        upstream_routes = routes((up / "src/overlay-server.ts").read_text(errors="replace"))
        candidate_routes = routes((candidate_root / "src/overlay-server.ts").read_text(errors="replace"))
        missing_routes = sorted(upstream_routes - candidate_routes, key=str)

    errors=[]
    if missing_ipc:
        errors.append("upstream IPC registrations missing:\n" + "\n".join(f"  {kind} {ch}" for kind,ch in missing_ipc))
    if missing_pre:
        errors.append("upstream preload API properties missing:\n" + "\n".join(f"  {k}" for k in missing_pre))
    if missing_routes:
        errors.append("upstream HTTP route contracts missing:\n" + "\n".join(f"  {verb or '*'} {path}" for path,verb in missing_routes))
    if errors:
        print(f"[upstream-contract] {label} failed:", file=sys.stderr)
        for e in errors:
            print(e, file=sys.stderr)
        raise SystemExit(120)
    route_text = f", HTTP routes={len(upstream_routes)}" if upstream_routes else ""
    print(
        f"[upstream-contract] {label} PASS: "
        f"upstream IPC={len(upstream_ipc)}, preload API={len(up_pre)}{route_text}"
    )


audit(work, "work tree")

with tempfile.TemporaryDirectory(prefix="alpha18-upstream-contract-") as td_s:
    td=Path(td_s)
    with tarfile.open(tar_path, "r:gz") as tf:
        tf.extractall(td)
    roots=[p for p in td.iterdir() if p.is_dir()]
    if len(roots) != 1 or not (roots[0] / "app/electron/main.cjs").exists():
        raise SystemExit("[upstream-contract] packaged root not recognized")
    audit(roots[0] / "app", "package")
