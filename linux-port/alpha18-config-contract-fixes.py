#!/usr/bin/env python3
from pathlib import Path
import sys

if len(sys.argv) != 2:
    raise SystemExit("usage: alpha18-config-contract-fixes.py WORK_DIR")
work = Path(sys.argv[1])
server = work / "src/overlay-server.ts"
s = server.read_text()

# The Alpha14 Linux patch introduced the field before upstream had it, but the old two-value type no
# longer matches the Settings UI. The profile is descriptive state derived from the three reader
# toggles, so keep the complete current vocabulary.
old_type = 'screenReaderProfile: "lightweight" | "full";'
new_type = 'screenReaderProfile: "lightweight" | "balanced" | "mining" | "custom";'
if old_type in s:
    s = s.replace(old_type, new_type, 1)
elif new_type not in s:
    raise SystemExit("config contract: screenReaderProfile Config type missing")

# Work only inside the /api/config POST handler. There are many saveConfig() calls in this server
# (Twitch, setup, changelog, etc.); a global line-pair anchor is unnecessarily fragile and can
# target the wrong concern after harmless upstream edits.
route_start = '  if (url === "/api/config" && req.method === "POST") {'
route_end = '\n  // Manual switch.'
a = s.find(route_start)
b = s.find(route_end, a + len(route_start)) if a >= 0 else -1
if a < 0 or b < 0:
    raise SystemExit("config contract: /api/config POST route boundaries missing")
route = s[a:b]

# Only F / hold mode / Shift+F6 are platform-owned. Forcing the OCR profile to lightweight on every
# POST made the Mining and Balanced buttons save the correct reader booleans but report the wrong
# profile, causing our save-verification UI to show a false failure.
forced = '''    if (process.platform === "linux") {
      config.interactHotkey = "F";
      config.holdToInteract = true;
      config.moveHotkey = "Shift+F6";
      config.screenReaderProfile = "lightweight";
    }'''
repaired = '''    if (process.platform === "linux") {
      config.interactHotkey = "F";
      config.holdToInteract = true;
      config.moveHotkey = "Shift+F6";
    }'''
if forced in route:
    route = route.replace(forced, repaired, 1)
elif repaired not in route:
    raise SystemExit("config contract: Linux POST repair block missing from config route")

# Derive the profile from the actual persisted reader booleans immediately before this route's one
# saveConfig(). This is the same truth table used by config.html.
profile_block = '''    const screenReaderProfile: Config["screenReaderProfile"] =
      !config.missionOcr && !config.miningAssistant && !config.fabCapture ? "lightweight" :
      config.missionOcr && !config.miningAssistant && !config.fabCapture ? "balanced" :
      !config.missionOcr && config.miningAssistant && !config.fabCapture ? "mining" : "custom";
    config.screenReaderProfile = screenReaderProfile;
'''
if 'const screenReaderProfile: Config["screenReaderProfile"]' not in route:
    save_token = '    await saveConfig();'
    if route.count(save_token) != 1:
        raise SystemExit(f"config contract: expected one saveConfig() in config route, found {route.count(save_token)}")
    route = route.replace(save_token, profile_block + save_token, 1)

# The merged Settings page verifies the values that were actually applied. Upstream 0.1.41 returned
# only {ok:true}, which makes a successful save look like a failure. Return a compact applied-state
# snapshot from this route only.
applied_response = '''    res.end(JSON.stringify({
      ok: true,
      screenReading: {
        fabCapture: config.fabCapture === true,
        missionOcr: config.missionOcr === true,
        miningAssistant: config.miningAssistant === true,
        profile: config.screenReaderProfile,
      },
    }));'''
if 'screenReading:' not in route:
    response_token = '    res.end(JSON.stringify({ ok: true }));'
    if route.count(response_token) != 1:
        raise SystemExit(f"config contract: expected one simple ok response in config route, found {route.count(response_token)}")
    route = route.replace(response_token, applied_response, 1)

s = s[:a] + route + s[b:]
server.write_text(s)

# Settings must present the same immutable Linux hotkeys that the shell/server enforce. Previously
# the Move key could appear editable even though the server silently repaired it to Shift+F6.
config = work / "overlay/config.html"
c = config.read_text()
linux_block_old = '''    if (IS_LINUX_DESKTOP) {
      setHotkeyDisplay("interact", "F");
      document.getElementById("interactHotkeyBtn").disabled = true;
      document.getElementById("interactHotkeyClear").style.display = "none";
      document.getElementById("interactHotkeyHint").textContent =
        "Linux keeps F as the permanent widget-entry key so the overlay cannot become unreachable.";
    }'''
linux_block_new = '''    if (IS_LINUX_DESKTOP) {
      setHotkeyDisplay("interact", "F");
      document.getElementById("interactHotkeyBtn").disabled = true;
      document.getElementById("interactHotkeyClear").style.display = "none";
      document.getElementById("interactHotkeyHint").textContent =
        "Linux keeps F as the permanent widget-entry key so the overlay cannot become unreachable.";
      setHotkeyDisplay("move", "Shift+F6");
      document.getElementById("moveHotkeyBtn").disabled = true;
      document.getElementById("moveHotkeyClear").style.display = "none";
      document.getElementById("moveHotkeyHint").textContent =
        "Linux keeps Shift+F6 as the permanent arrange-mode key.";
    }'''
if linux_block_old in c:
    c = c.replace(linux_block_old, linux_block_new, 1)
elif 'setHotkeyDisplay("move", "Shift+F6")' not in c:
    raise SystemExit("config contract: Linux Settings hotkey block missing")

save_hotkey_old = '''        body[which + "Hotkey"] = IS_LINUX_DESKTOP && which === "interact"
          ? "F"
          : document.getElementById(HOTKEYS[which].input).value.trim();'''
save_hotkey_new = '''        body[which + "Hotkey"] = IS_LINUX_DESKTOP && which === "interact"
          ? "F"
          : IS_LINUX_DESKTOP && which === "move"
            ? "Shift+F6"
            : document.getElementById(HOTKEYS[which].input).value.trim();'''
if save_hotkey_old in c:
    c = c.replace(save_hotkey_old, save_hotkey_new, 1)
elif 'IS_LINUX_DESKTOP && which === "move"' not in c:
    raise SystemExit("config contract: hotkey save block missing")

# 0.1.41's current function has no pre-existing Linux guard; older Linux snapshots did. Insert the
# immutable-key guard immediately after the function boundary rather than depending on either body
# shape. This keeps all ordinary upstream hotkey capture behavior intact for every other action.
guard = '    if (IS_LINUX_DESKTOP && (which === "interact" || which === "move")) return;'
if guard not in c:
    function_anchors = [
        '  function startCaptureHotkey(which) {\n',
        '  async function startCaptureHotkey(which) {\n',
    ]
    for function_anchor in function_anchors:
        if function_anchor in c:
            c = c.replace(function_anchor, function_anchor + guard + '\n', 1)
            break
    else:
        raise SystemExit("config contract: startCaptureHotkey function boundary missing")
if c.count(guard) != 1:
    raise SystemExit(f"config contract: expected one Linux hotkey capture guard, found {c.count(guard)}")

config.write_text(c)
print("[alpha18-config-contract] Settings/API/profile round-trip contract PASS")
