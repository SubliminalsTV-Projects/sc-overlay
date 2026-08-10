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
    # 1) Alpha 18 owns the Linux interaction state; 0.1.42 adds opacity state beside it.
    if "let fHoverHeld = false;" in ours and "let unfocusedOpacity = 1;" in theirs:
        merged = ours
        anchor = "let chatVisible = false;\n"
        addition = (
            "let unfocusedOpacity = 1;\n"
            "let opacityOverride = false;\n"
        )
        if anchor not in merged:
            raise SystemExit("main conflict 1 anchor missing")
        if "let unfocusedOpacity = 1;" not in merged:
            merged = merged.replace(anchor, anchor + addition, 1)
        return merged

    # 2) Keep the proven Linux focus-latch/blur behavior and add upstream's opacity refresh.
    if "before-mouse-event" in ours and "applyOverlayOpacity" in theirs:
        merged = ours
        merged += (
            "  overlay.on(\"focus\", applyOverlayOpacity);\n"
            "  overlay.on(\"blur\", applyOverlayOpacity);\n"
            "  applyOverlayOpacity();\n"
        )
        return merged

    # 3) Upstream pollCursor cannot replace the Gamescope/XWayland F-hover state machine.
    # The 0.1.42 opacity implementation is renderer-driven and its poll-time refresh is not
    # required for the Linux classifier, so retain the Alpha 18 block intact.
    if "function updateFHoverHitFromRegions()" in ours and "function pollCursor()" in theirs:
        return ours

    # 4) Keep Linux-owned F/hold/Shift+F6 while accepting 0.1.42 opacity settings/hotkey.
    if "moveKey = \"Shift+F6\"" in ours and "unfocusedOpacity" in theirs:
        return (
            "      if (Number.isFinite(c.unfocusedOpacity)) setUnfocusedOpacity(c.unfocusedOpacity);\n"
            "      if (typeof c.opacityHotkey === \"string\") registerOpacityHotkey(c.opacityHotkey);\n"
            "      if (process.platform === \"linux\") { fHoverEnabled = true; holdMode = true; interactKey = \"F\"; moveKey = \"Shift+F6\"; }\n"
            "      else holdMode = c.holdToInteract === true;\n"
        )

    raise SystemExit(f"unexpected main.cjs conflict #{idx}")


def resolve_config(ours: str, base: str, theirs: str, idx: int) -> str:
    # ArchVerse's Linux-safe controls and screen-reader profile UI are intentional. 0.1.42 adds
    # the new unfocused-opacity slider in the same loadCfg region. Preserve both behaviors.
    if "holdToInteract" in ours and "setOpacitySlider" in theirs:
        merged = ours
        if "setOpacitySlider" not in merged:
            anchor = "    hotkeysLoaded = true;\n"
            line = "    setOpacitySlider(Number.isFinite(cfg.unfocusedOpacity) ? Math.round(cfg.unfocusedOpacity * 100) : 100);\n"
            if anchor not in merged:
                raise SystemExit("config opacity insertion anchor missing")
            merged = merged.replace(anchor, anchor + line, 1)
        return merged
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
