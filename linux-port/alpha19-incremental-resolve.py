#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: alpha19-incremental-resolve.py WORK_DIR")

work = Path(sys.argv[1])

START = "<<<<<<< ArchVerse audited Alpha18\n"
BASE = "||||||| upstream 0.1.41\n"
SEP = "=======\n"
END = ">>>>>>> upstream 0.1.42\n"


def split_conflicts(text: str):
    out = []
    pos = 0
    while True:
        a = text.find(START, pos)
        if a < 0:
            out.append(("text", text[pos:]))
            break
        out.append(("text", text[pos:a]))
        b = text.find(BASE, a + len(START))
        c = text.find(SEP, b + len(BASE)) if b >= 0 else -1
        d = text.find(END, c + len(SEP)) if c >= 0 else -1
        if min(b, c, d) < 0:
            raise SystemExit("malformed diff3 conflict")
        ours = text[a + len(START):b]
        base = text[b + len(BASE):c]
        theirs = text[c + len(SEP):d]
        out.append(("conflict", ours, base, theirs))
        pos = d + len(END)
    return out


def resolve_main(ours: str, base: str, theirs: str, idx: int) -> str:
    if "let fHoverHeld = false;" in ours and "let unfocusedOpacity = 1;" in theirs:
        merged = ours
        anchor = "let chatVisible = false;\n"
        addition = "let unfocusedOpacity = 1;\nlet opacityOverride = false;\n"
        if anchor not in merged:
            raise SystemExit("main conflict 1 anchor missing")
        if "let unfocusedOpacity = 1;" not in merged:
            merged = merged.replace(anchor, anchor + addition, 1)
        return merged

    if "before-mouse-event" in ours and "applyOverlayOpacity" in theirs:
        return ours + (
            "  overlay.on(\"focus\", applyOverlayOpacity);\n"
            "  overlay.on(\"blur\", applyOverlayOpacity);\n"
            "  applyOverlayOpacity();\n"
        )

    if "function updateFHoverHitFromRegions()" in ours and "function pollCursor()" in theirs:
        return ours

    if "moveKey = \"Shift+F6\"" in ours and "unfocusedOpacity" in theirs:
        return (
            "      if (Number.isFinite(c.unfocusedOpacity)) setUnfocusedOpacity(c.unfocusedOpacity);\n"
            "      if (typeof c.opacityHotkey === \"string\") registerOpacityHotkey(c.opacityHotkey);\n"
            "      if (process.platform === \"linux\") { fHoverEnabled = true; holdMode = true; interactKey = \"F\"; moveKey = \"Shift+F6\"; }\n"
            "      else holdMode = c.holdToInteract === true;\n"
        )

    raise SystemExit(f"unexpected main.cjs conflict #{idx}")


def resolve_config(ours: str, base: str, theirs: str, idx: int) -> str:
    # Exact overlap: 0.1.42 inserts the new opacity slider immediately before the hold-to-interact
    # control, while ArchVerse replaces that hold control with the Linux-locked F interaction UI.
    # Keep both: upstream slider first, then the proven Linux hold-control block.
    if "holdToInteract" in ours and "setOpacitySlider" in theirs:
        return (
            "    setOpacitySlider(Number.isFinite(cfg.unfocusedOpacity) ? Math.round(cfg.unfocusedOpacity * 100) : 100);\n"
            + ours
        )
    raise SystemExit(f"unexpected config.html conflict #{idx}")


def resolve_file(path: Path, resolver):
    text = path.read_text()
    if START not in text:
        return 0
    pieces = split_conflicts(text)
    result = []
    n = 0
    for part in pieces:
        if part[0] == "text":
            result.append(part[1])
            continue
        n += 1
        _, ours, base, theirs = part
        result.append(resolver(ours, base, theirs, n))
    merged = "".join(result)
    for marker in ("<<<<<<<", "|||||||", "=======", ">>>>>>>"):
        if marker in merged:
            raise SystemExit(f"{path}: conflict marker survived")
    path.write_text(merged)
    return n

main_n = resolve_file(work / "electron/main.cjs", resolve_main)
config_n = resolve_file(work / "overlay/config.html", resolve_config)

if main_n != 4:
    raise SystemExit(f"expected 4 main.cjs conflicts, resolved {main_n}")
if config_n != 1:
    raise SystemExit(f"expected 1 config.html conflict, resolved {config_n}")

print(f"[alpha19-resolve] resolved {main_n} main.cjs + {config_n} config.html incremental conflicts")
