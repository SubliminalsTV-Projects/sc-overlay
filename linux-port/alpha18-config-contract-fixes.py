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
s = s.replace(
    'screenReaderProfile: "lightweight" | "full";',
    'screenReaderProfile: "lightweight" | "balanced" | "mining" | "custom";',
    1,
)

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
if forced in s:
    s = s.replace(forced, repaired, 1)
elif repaired not in s:
    raise SystemExit("config contract: Linux POST repair block missing")

# Derive the profile from the persisted reader booleans using the same truth table as config.html.
# This makes the disk state, API response and UI selection describe the same thing.
save_anchor = '''    await saveConfig();
    broadcastMissions();
'''
profile_block = '''    const screenReaderProfile: Config["screenReaderProfile"] =
      !config.missionOcr && !config.miningAssistant && !config.fabCapture ? "lightweight" :
      config.missionOcr && !config.miningAssistant && !config.fabCapture ? "balanced" :
      !config.missionOcr && config.miningAssistant && !config.fabCapture ? "mining" : "custom";
    config.screenReaderProfile = screenReaderProfile;
    await saveConfig();
    broadcastMissions();
'''
if save_anchor in s:
    s = s.replace(save_anchor, profile_block, 1)
elif 'const screenReaderProfile: Config["screenReaderProfile"]' not in s:
    raise SystemExit("config contract: save/profile insertion anchor missing")

# Our merged Settings page intentionally verifies that the requested screen-reader state actually
# survived the round trip. Upstream 0.1.41 returns only {ok:true}; restore a compact applied-state
# payload instead of weakening the UI verification.
response_anchor = '''    broadcastMissions();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (url === "/api/active" && req.method === "POST") {'''
response = '''    broadcastMissions();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      screenReading: {
        fabCapture: config.fabCapture === true,
        missionOcr: config.missionOcr === true,
        miningAssistant: config.miningAssistant === true,
        profile: config.screenReaderProfile,
      },
    }));
    return;
  }
  if (url === "/api/active" && req.method === "POST") {'''
if response_anchor in s:
    s = s.replace(response_anchor, response, 1)
elif 'profile: config.screenReaderProfile' not in s:
    raise SystemExit("config contract: POST response anchor missing")

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
elif 'which === "move"' not in c:
    raise SystemExit("config contract: hotkey save block missing")

capture_anchor = '''  async function startCaptureHotkey(which) {
    if (IS_LINUX_DESKTOP && which === "interact") return;'''
capture_repl = '''  async function startCaptureHotkey(which) {
    if (IS_LINUX_DESKTOP && (which === "interact" || which === "move")) return;'''
if capture_anchor in c:
    c = c.replace(capture_anchor, capture_repl, 1)
elif 'which === "interact" || which === "move"' not in c:
    # Upstream may place the guard a few lines into the function; handle the one-line form too.
    one = 'if (IS_LINUX_DESKTOP && which === "interact") return;'
    if one in c:
        c = c.replace(one, 'if (IS_LINUX_DESKTOP && (which === "interact" || which === "move")) return;', 1)
    else:
        raise SystemExit("config contract: hotkey capture guard missing")

config.write_text(c)
print("[alpha18-config-contract] Settings/API/profile round-trip contract PASS")
