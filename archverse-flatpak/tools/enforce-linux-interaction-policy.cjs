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
//
// Future upstream upgrades are expected to pass through this script. If upstream refactors the
// relevant lifecycle hooks, this script intentionally fails closed so CI cannot silently ship a
// Linux package with different focus semantics.
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

must(main.includes('ARCHVERSE_LINUX_HOVER_SCOPED_LATCH'), 'hover-scoped latch marker missing');
must(main.includes('const LINUX_HOVER_LATCH_MISS_MS = 90;'), 'hover-exit debounce changed');
must(main.includes('startLinuxHoverScopedLatch();'), 'hover-scoped latch is not started with Linux focus watch');
must(main.includes('stopLinuxHoverScopedLatch();'), 'hover-scoped latch is not stopped on Linux shutdown');
must(main.includes('releaseOverlayOwnershipToDesktop("pointer left all widgets after interaction-key release")'), 'pointer exit does not release overlay ownership');
must(main.includes('restoreLinuxPreviousWindow();'), 'pointer exit does not restore pre-overlay focus');
must(main.includes('[linux-interaction] pointer left all widgets; overlay released and previous focus restored'), 'focus-return diagnostic missing');

fs.writeFileSync(mainPath, main);
console.log('Linux hover-scoped interaction policy applied and verified');
