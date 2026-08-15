#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const [mainPath] = process.argv.slice(2);
if (!mainPath) {
  console.error('usage: enforce-linux-interaction-policy.cjs <main.cjs>');
  process.exit(2);
}

function must(cond, msg) {
  if (!cond) throw new Error(`Linux interaction policy: ${msg}`);
}

function replaceOnce(text, from, to, label) {
  if (text.includes(to)) return text;
  const count = text.split(from).length - 1;
  must(count === 1, `${label}: expected exactly one anchor, found ${count}`);
  return text.replace(from, to);
}

let main = fs.readFileSync(mainPath, 'utf8');

// Promote the temporary 0.1.43 field-test implementation into the permanent Linux contract when
// packaging a shell that already carries it. This keeps current 0.1.43 builds byte-behaviorally
// equivalent while removing the version-specific ownership of the policy.
if (!main.includes('ARCHVERSE_LINUX_HOVER_SCOPED_LATCH') && main.includes('ARCHVERSE_FLATPAK_HOVER_SCOPED_LATCH')) {
  const renames = [
    ['ARCHVERSE_FLATPAK_HOVER_SCOPED_LATCH', 'ARCHVERSE_LINUX_HOVER_SCOPED_LATCH'],
    ['postReleaseHoverTimer043', 'linuxHoverLatchTimer'],
    ['postReleaseHoverMissSince043', 'linuxHoverLatchMissSince'],
    ['POST_RELEASE_HOVER_MISS_MS_043', 'LINUX_HOVER_LATCH_MISS_MS'],
    ['postReleasePointerInsideWidget043', 'linuxPointerInsideClassifiedWidget'],
    ['tickPostReleaseHoverLatch043', 'tickLinuxHoverScopedLatch'],
    ['startPostReleaseHoverLatch043', 'startLinuxHoverScopedLatch'],
    ['stopPostReleaseHoverLatch043', 'stopLinuxHoverScopedLatch'],
    ['pointer left all widgets after F release', 'pointer left all widgets after interaction-key release'],
    ['[focus-latch] pointer left all widgets after interaction-key release; click-through restored and previous focus returned',
      '[linux-interaction] pointer left all widgets; overlay released and previous focus restored'],
  ];
  for (const [from, to] of renames) main = main.split(from).join(to);
}

// This is a durable Linux behavior contract, not an upstream-version-specific tweak.
//
// Required behavior:
//  1. Holding the interaction key does not focus the full transparent canvas by itself.
//  2. Focus is taken only after the pointer enters a classified widget.
//  3. Clicking a widget may keep it interactive after the key is released so text fields,
//     checkboxes, scrolling, etc. remain usable.
//  4. That post-release latch is scoped to widget hover. Leaving every classified widget releases
//     all overlay input ownership after a very short debounce, restores click-through, and returns
//     focus to the exact native window captured before ArchVerse took focus.
//  5. The transparent canvas must not require a later click, Alt-Tab, Super, or a Star Citizen-
//     specific focus hack to escape it.
//  6. Flatpak interaction must not depend on raw /dev/input readability. evdev is optional; an
//     X11/XWayland key-state backend is mandatory because Linux distributions apply different
//     device ACL/group policies even when Flatpak exposes --device=input.
//
// Future upstream upgrades are expected to pass through this script. If upstream refactors the
// relevant lifecycle hooks, this script intentionally fails closed so CI cannot silently ship a
// Linux package with different focus or held-key semantics.
if (!main.includes('ARCHVERSE_LINUX_HOVER_SCOPED_LATCH')) {
  const lifecycleAnchor = 'let linuxScLifecycleTimer = null;';
  must(main.includes(lifecycleAnchor), 'missing Linux desktop-focus lifecycle anchor');
  must(main.includes('function releaseOverlayOwnershipToDesktop('), 'missing overlay ownership release helper');
  must(main.includes('function restoreLinuxPreviousWindow()'), 'missing previous-window focus restore helper');
  must(main.includes('function overlayRegionAtPoint('), 'missing classified widget hit-test helper');

  const policy = `let linuxHoverLatchTimer = null;\nlet linuxHoverLatchMissSince = 0;\nconst LINUX_HOVER_LATCH_MISS_MS = 90;\n\nfunction linuxPointerInsideClassifiedWidget() {\n  let p = null;\n  try { p = overlayWindows.pointerLocation?.(); } catch {}\n  if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) {\n    try { p = screen.getCursorScreenPoint(); } catch {}\n  }\n  // Unknown pointer state is fail-safe: keep the current widget latch rather than unexpectedly\n  // stealing focus away from a text field while the compositor is between pointer samples.\n  if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return true;\n  try { return !!overlayRegionAtPoint({ x: Number(p.x), y: Number(p.y) }); } catch { return true; }\n}\n\nfunction tickLinuxHoverScopedLatch() {\n  // ARCHVERSE_LINUX_HOVER_SCOPED_LATCH: a clicked widget may remain interactive after F-up, but\n  // the full-screen transparent canvas never owns focus once the pointer has left all widgets.\n  if (fHoverHeld || !overlayInteractionLatched || modalOpen || dragging || moveMode || miningMoveMode) {\n    linuxHoverLatchMissSince = 0;\n    return;\n  }\n  if (linuxPointerInsideClassifiedWidget()) {\n    linuxHoverLatchMissSince = 0;\n    return;\n  }\n  const now = Date.now();\n  if (!linuxHoverLatchMissSince) {\n    linuxHoverLatchMissSince = now;\n    return;\n  }\n  if (now - linuxHoverLatchMissSince < LINUX_HOVER_LATCH_MISS_MS) return;\n\n  linuxHoverLatchMissSince = 0;\n  const released = releaseOverlayOwnershipToDesktop("pointer left all widgets after interaction-key release");\n  if (!released) return;\n\n  // The input shape must be click-through before focus is restored. No mouse event is synthesized;\n  // after this handoff the next real click belongs naturally to the window beneath the canvas.\n  setTimeout(() => {\n    if (overlayExclusiveInteractionActive()) return;\n    restoreLinuxPreviousWindow();\n    console.log("[linux-interaction] pointer left all widgets; overlay released and previous focus restored");\n  }, 35);\n}\n\nfunction startLinuxHoverScopedLatch() {\n  if (linuxHoverLatchTimer) return;\n  linuxHoverLatchTimer = setInterval(tickLinuxHoverScopedLatch, 32);\n  linuxHoverLatchTimer.unref?.();\n}\n\nfunction stopLinuxHoverScopedLatch() {\n  if (linuxHoverLatchTimer) clearInterval(linuxHoverLatchTimer);\n  linuxHoverLatchTimer = null;\n  linuxHoverLatchMissSince = 0;\n}\n\n${lifecycleAnchor}`;
  main = main.replace(lifecycleAnchor, policy);

  const startAnchor = 'function startLinuxDesktopFocusWatch() {\n  if (process.platform !== "linux" || linuxScLifecycleTimer) return;';
  const startReplacement = 'function startLinuxDesktopFocusWatch() {\n  if (process.platform !== "linux" || linuxScLifecycleTimer) return;\n  startLinuxHoverScopedLatch();';
  main = replaceOnce(main, startAnchor, startReplacement, 'policy startup hook');

  const stopAnchor = 'function stopLinuxDesktopFocusWatch() {\n  if (linuxScLifecycleTimer) clearInterval(linuxScLifecycleTimer);';
  const stopReplacement = 'function stopLinuxDesktopFocusWatch() {\n  stopLinuxHoverScopedLatch();\n  if (linuxScLifecycleTimer) clearInterval(linuxScLifecycleTimer);';
  main = replaceOnce(main, stopAnchor, stopReplacement, 'policy shutdown hook');
}

// Durable Linux held-key backend policy. Raw evdev access is useful when the host grants it, but
// Fedora/Nobara commonly exposes /dev/input to the Flatpak while still denying open(2) through the
// host's Unix ACL/group policy. Querying the X11/XWayland keymap uses the already-authorized X11
// socket and works regardless of those device permissions. It runs alongside evdev; the existing
// fHoverHeld guards de-duplicate edges when both backends are available.
if (!main.includes('ARCHVERSE_LINUX_X11_HOLD_KEY')) {
  const controllerAnchor = 'let evdevInteractController = null;';
  must(main.includes(controllerAnchor), 'missing evdev interaction controller anchor');

  const x11Policy = `// ARCHVERSE_LINUX_X11_HOLD_KEY: portable held-key fallback for X11/XWayland Flatpaks.\nfunction linuxX11KeysymName(accelerator) {\n  const raw = String(accelerator || "").trim();\n  if (!raw || raw.includes("+")) return null;\n  const aliases = {\n    RightAlt: "Alt_R", LeftAlt: "Alt_L", Alt: "Alt_L",\n    RightControl: "Control_R", LeftControl: "Control_L", Control: "Control_L", Ctrl: "Control_L",\n    RightShift: "Shift_R", LeftShift: "Shift_L", Shift: "Shift_L",\n    RightSuper: "Super_R", LeftSuper: "Super_L", Super: "Super_L", Meta: "Super_L",\n    Enter: "Return", Escape: "Escape", Esc: "Escape", Space: "space", Tab: "Tab",\n    Backspace: "BackSpace", Delete: "Delete", Insert: "Insert", Home: "Home", End: "End",\n    PageUp: "Page_Up", PageDown: "Page_Down", Up: "Up", Down: "Down", Left: "Left", Right: "Right",\n  };\n  return aliases[raw] || raw;\n}\n\nfunction startLinuxX11HoldKey({ accelerator, onDown, onUp }) {\n  if (process.platform !== "linux" || process.env.SC_TRACKER_FLATPAK !== "1") return { supported: false, stop() {} };\n  const keysymName = linuxX11KeysymName(accelerator);\n  if (!keysymName) {\n    console.warn(\`[x11-key] unsupported held-key accelerator: \${accelerator}\`);\n    return { supported: false, stop() {} };\n  }\n\n  let XCloseDisplay = null;\n  let display = null;\n  let timer = null;\n  let stopped = false;\n  try {\n    const koffi = require("koffi");\n    const x11 = koffi.load("libX11.so.6");\n    const XOpenDisplay = x11.func("void *XOpenDisplay(const char *display_name)");\n    XCloseDisplay = x11.func("int XCloseDisplay(void *display)");\n    const XStringToKeysym = x11.func("unsigned long XStringToKeysym(const char *string)");\n    const XKeysymToKeycode = x11.func("uint8_t XKeysymToKeycode(void *display, unsigned long keysym)");\n    const XQueryKeymap = x11.func("int XQueryKeymap(void *display, _Out_ char *keys_return)");\n\n    display = XOpenDisplay(process.env.DISPLAY || null);\n    if (!display) throw new Error(\`XOpenDisplay failed for DISPLAY=\${process.env.DISPLAY || "(unset)"}\`);\n    const keysym = XStringToKeysym(keysymName);\n    if (!keysym) throw new Error(\`unknown X11 keysym \${keysymName}\`);\n    const keycode = Number(XKeysymToKeycode(display, keysym));\n    if (!keycode) throw new Error(\`no X11 keycode for \${keysymName}\`);\n\n    const map = Buffer.alloc(32);\n    let initialized = false;\n    let wasDown = false;\n    const tick = () => {\n      if (stopped || !display) return;\n      try {\n        map.fill(0);\n        XQueryKeymap(display, map);\n        const isDown = !!(map[keycode >> 3] & (1 << (keycode & 7)));\n        if (!initialized) {\n          initialized = true;\n          wasDown = isDown;\n          if (isDown) onDown("x11");\n          return;\n        }\n        if (isDown === wasDown) return;\n        wasDown = isDown;\n        if (isDown) onDown("x11");\n        else onUp("x11");\n      } catch (error) {\n        console.warn(\`[x11-key] key-state query failed: \${String(error?.message || error)}\`);\n      }\n    };\n\n    tick();\n    timer = setInterval(tick, 16);\n    timer.unref?.();\n    console.log(\`[x11-key] fallback ready for \${accelerator} keysym=\${keysymName} keycode=\${keycode}\`);\n    return {\n      supported: true,\n      stop() {\n        if (stopped) return;\n        stopped = true;\n        if (timer) clearInterval(timer);\n        timer = null;\n        try { if (display && XCloseDisplay) XCloseDisplay(display); } catch {}\n        display = null;\n      },\n    };\n  } catch (error) {\n    if (timer) clearInterval(timer);\n    try { if (display && XCloseDisplay) XCloseDisplay(display); } catch {}\n    console.warn(\`[x11-key] fallback unavailable: \${String(error?.message || error)}\`);\n    return { supported: false, stop() {} };\n  }\n}\n\n${controllerAnchor}\nlet x11InteractController = null;`;
  main = main.replace(controllerAnchor, x11Policy);

  const startEvdev = '    evdevInteractController = startEvdevHoldKey({ accelerator: accel, onDown: () => onDown("evdev"), onUp: () => onUp("evdev") });';
  must(main.includes(startEvdev), 'missing evdev held-key startup');
  main = main.replace(startEvdev, `${startEvdev}\n    x11InteractController = startLinuxX11HoldKey({ accelerator: accel, onDown: () => onDown("x11"), onUp: () => onUp("x11") });`);

  const returnOld = '  return (r.ok || evdevInteractController?.supported) ? { ok: true } : r;';
  const returnNew = '  return (r.ok || evdevInteractController?.supported || x11InteractController?.supported) ? { ok: true } : r;';
  main = replaceOnce(main, returnOld, returnNew, 'portable held-key backend return');

  const evdevCleanup = 'if (evdevInteractController) { try { evdevInteractController.stop(); } catch {} evdevInteractController=null; }';
  const cleanupCount = main.split(evdevCleanup).length - 1;
  must(cleanupCount >= 1, 'missing evdev controller cleanup');
  main = main.split(evdevCleanup).join(`${evdevCleanup}\n    if (x11InteractController) { try { x11InteractController.stop(); } catch {} x11InteractController=null; }`);
}

must(main.includes('ARCHVERSE_LINUX_HOVER_SCOPED_LATCH'), 'hover-scoped latch marker missing');
must(main.includes('const LINUX_HOVER_LATCH_MISS_MS = 90;'), 'hover-exit debounce changed');
must(main.includes('startLinuxHoverScopedLatch();'), 'hover-scoped latch is not started with Linux focus watch');
must(main.includes('stopLinuxHoverScopedLatch();'), 'hover-scoped latch is not stopped on Linux shutdown');
must(main.includes('releaseOverlayOwnershipToDesktop("pointer left all widgets after interaction-key release")'), 'pointer exit does not release overlay ownership');
must(main.includes('restoreLinuxPreviousWindow();'), 'pointer exit does not restore pre-overlay focus');
must(main.includes('[linux-interaction] pointer left all widgets; overlay released and previous focus restored'), 'focus-return diagnostic missing');
must(main.includes('ARCHVERSE_LINUX_X11_HOLD_KEY'), 'portable X11 held-key backend marker missing');
must(main.includes('[x11-key] fallback ready for'), 'X11 held-key readiness diagnostic missing');
must(main.includes('x11InteractController?.supported'), 'held-key registration does not accept X11 backend');
must(main.includes('startLinuxX11HoldKey({ accelerator: accel'), 'X11 held-key backend is not started with evdev');

fs.writeFileSync(mainPath, main);
console.log('Linux hover-scoped interaction and portable held-key policies applied and verified');
