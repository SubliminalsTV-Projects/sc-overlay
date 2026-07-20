// Global hotkey backend — a LOW-LEVEL keyboard hook, not Windows RegisterHotKey.
//
// Electron's globalShortcut (= RegisterHotKey) does NOT fire while a fullscreen game
// (Star Citizen) has focus — SC grabs the keyboard through Raw Input / DirectInput, which
// swallows the key before WM_HOTKEY is generated. So the overlay/binding/mining hotkeys
// were dead in-game and only worked alt-tabbed. A WH_KEYBOARD_LL hook (via uiohook-napi,
// the same passive-hook technique OBS / Discord / RTSS use) sees keystrokes system-wide
// regardless of focus and does NOT inject into the game process (EAC-safe).
//
// If the native hook can't load on a given machine, we fall back to globalShortcut so the
// hotkeys still work at least while alt-tabbed. The public API (register / unregister /
// unregisterAll returning {ok,error}) mirrors globalShortcut so callers are unchanged.
const { globalShortcut } = require("electron");

let uio = null, UKey = null, hookLoaded = false, started = false;
try {
  const m = require("uiohook-napi");
  uio = m.uIOhook; UKey = m.UiohookKey;
  hookLoaded = !!(uio && UKey);
} catch (e) {
  console.error("[hotkeys] uiohook-napi unavailable — falling back to globalShortcut:", (e && e.message) || e);
}

// accel string -> { spec, cb, fallback } where spec = { code, ctrl, alt, shift, meta }.
const bindings = new Map();
// accels currently held down, so a held key's auto-repeat only fires the callback once.
const held = new Set();

// Electron accelerator key token -> uiohook virtual keycode. Covers exactly the tokens the
// config window's capture flow can produce (F1–F24, letters, digits, nav + punctuation).
function keycodeFor(key) {
  if (!UKey || !key) return null;
  let m;
  if ((m = /^F(\d{1,2})$/.exec(key))) { const c = UKey["F" + m[1]]; return c == null ? null : c; }
  if (/^[A-Za-z]$/.test(key)) { const c = UKey[key.toUpperCase()]; return c == null ? null : c; }
  if (/^[0-9]$/.test(key)) { const c = UKey[key]; return c == null ? null : c; }
  const map = {
    ";": UKey.Semicolon, "'": UKey.Quote, ",": UKey.Comma, ".": UKey.Period, "/": UKey.Slash,
    "\\": UKey.Backslash, "[": UKey.BracketLeft, "]": UKey.BracketRight, "-": UKey.Minus,
    "=": UKey.Equal, "`": UKey.Backquote,
    Space: UKey.Space, Tab: UKey.Tab, Up: UKey.ArrowUp, Down: UKey.ArrowDown,
    Left: UKey.ArrowLeft, Right: UKey.ArrowRight,
  };
  return map[key] == null ? null : map[key];
}

function specFor(accel) {
  const parts = String(accel).split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const key = parts.pop();
  const mods = parts.map((p) => p.toLowerCase());
  const code = keycodeFor(key);
  if (code == null) return null;
  return {
    code,
    ctrl: mods.includes("control") || mods.includes("ctrl") || mods.includes("commandorcontrol") || mods.includes("cmdorctrl"),
    alt: mods.includes("alt") || mods.includes("option"),
    shift: mods.includes("shift"),
    meta: mods.includes("super") || mods.includes("meta") || mods.includes("cmd") || mods.includes("command"),
  };
}

// A signature that's identical for two accelerators that resolve to the same physical key +
// modifiers (regardless of casing / modifier order), used to reject collisions.
function sigOf(spec) {
  return `${spec.code}|${spec.ctrl ? 1 : 0}${spec.alt ? 1 : 0}${spec.shift ? 1 : 0}${spec.meta ? 1 : 0}`;
}

// A binding fires only on an EXACT modifier match, so "F3" and "Shift+F3" never cross-fire.
function onKeydown(e) {
  for (const [accel, b] of bindings) {
    if (b.fallback) continue;
    const s = b.spec;
    if (e.keycode === s.code && !!e.ctrlKey === s.ctrl && !!e.altKey === s.alt &&
        !!e.shiftKey === s.shift && !!e.metaKey === s.meta) {
      if (held.has(accel)) continue; // suppress auto-repeat while the key is held
      held.add(accel);
      try { b.cb(); } catch { /* callback threw — ignore */ }
    }
  }
}
function onKeyup(e) {
  for (const [accel, b] of bindings) {
    if (b.fallback || !b.spec || b.spec.code !== e.keycode) continue;
    held.delete(accel);
    // A HOLD binding fires its release callback when the key comes up (interact-to-hold).
    if (b.hold && typeof b.cbUp === "function") { try { b.cbUp(); } catch { /* ignore */ } }
  }
}

function ensureStarted() {
  if (!hookLoaded || started) return;
  uio.on("keydown", onKeydown);
  uio.on("keyup", onKeyup);
  try { uio.start(); started = true; }
  catch (e) { hookLoaded = false; console.error("[hotkeys] uIOhook.start failed — falling back:", (e && e.message) || e); }
}

// Register an accelerator. Returns {ok:true} | {ok:false,error} — same contract as
// globalShortcut.register so the config window's warnings work unchanged.
function register(accel, cb) {
  if (!accel || typeof accel !== "string") return { ok: true };
  if (hookLoaded) {
    const spec = specFor(accel);
    if (!spec) return { ok: false, error: "invalid" };
    // Exclusivity, like RegisterHotKey: reject a key already claimed by another action, so
    // one keypress can't fire two callbacks. (The caller unregisters its own old accel first,
    // so a live rebind to the same key is fine.)
    const sig = sigOf(spec);
    for (const b of bindings.values()) if (!b.fallback && b.sig === sig) return { ok: false, error: "in_use" };
    bindings.set(accel, { spec, sig, cb, fallback: false });
    ensureStarted();
    if (hookLoaded) return { ok: true }; // start() may have flipped hookLoaded off
    bindings.delete(accel); // hook died on start — fall through to globalShortcut
  }
  try {
    if (globalShortcut.register(accel, cb)) { bindings.set(accel, { fallback: true, cb }); return { ok: true }; }
    return { ok: false, error: "in_use" };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// Register a HOLD hotkey: onDown fires on key press, onUp on release. Requires the low-level
// hook (globalShortcut can't observe key-up), so it reports {ok:false,error:"no_hook"} if the
// hook is unavailable rather than silently degrading to a press-only shortcut.
function registerHold(accel, onDown, onUp) {
  if (!accel || typeof accel !== "string") return { ok: true };
  if (!hookLoaded) return { ok: false, error: "no_hook" };
  const spec = specFor(accel);
  if (!spec) return { ok: false, error: "invalid" };
  const sig = sigOf(spec);
  for (const b of bindings.values()) if (!b.fallback && b.sig === sig) return { ok: false, error: "in_use" };
  bindings.set(accel, { spec, sig, cb: onDown, cbUp: onUp, hold: true, fallback: false });
  ensureStarted();
  return hookLoaded ? { ok: true } : { ok: false, error: "no_hook" };
}

function unregister(accel) {
  const b = bindings.get(accel);
  if (b && b.fallback) { try { globalShortcut.unregister(accel); } catch { /* ignore */ } }
  bindings.delete(accel);
  held.delete(accel);
}

function unregisterAll() {
  for (const [accel, b] of bindings) if (b.fallback) { try { globalShortcut.unregister(accel); } catch { /* ignore */ } }
  bindings.clear();
  held.clear();
  if (hookLoaded && started) { try { uio.stop(); } catch { /* ignore */ } started = false; }
}

// Whether hotkeys are backed by the low-level hook (true) vs the globalShortcut fallback.
function isLowLevel() { return hookLoaded; }

module.exports = { register, registerHold, unregister, unregisterAll, isLowLevel };
