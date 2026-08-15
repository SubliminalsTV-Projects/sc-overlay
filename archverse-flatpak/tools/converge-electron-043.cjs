#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const [capturePath, mainPath] = process.argv.slice(2);
if (!capturePath || !mainPath) {
  console.error('usage: converge-electron-043.cjs <capture.cjs> <main.cjs>');
  process.exit(2);
}

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { fs.writeFileSync(p, s); }
function must(cond, msg) { if (!cond) throw new Error(msg); }
function replaceOnce(text, from, to, label) {
  if (text.includes(to)) return text;
  const n = text.split(from).length - 1;
  must(n === 1, `${label}: expected exactly one old form, found ${n}`);
  return text.replace(from, to);
}

let capture = read(capturePath);

// 0.1.43 convergence rule: radar/scan-mode heuristics may remain as telemetry, but they may not
// decide whether the reliable cropped RapidOCR reader gets to look. A recent parsed signature is
// sufficient to keep the tight crop locked, and mining itself is sufficient to run the crop pass.
capture = replaceOnce(
  capture,
  'const locked = mining && archScanModeRead.active && sigBox && Date.now() - sigBoxAt < SIG_LOCK_MS;',
  'const locked = mining && sigBox && Date.now() - sigBoxAt < SIG_LOCK_MS;',
  'mining lock gate'
);

capture = replaceOnce(
  capture,
  'const needGeneric = fab || miss || claim || payout || (mining && archScanModeRead.active);',
  'const needGeneric = fab || miss || claim || payout;',
  'generic OCR gate'
);

// Older Linux shells had variants where RapidOCR was conditioned on scan-mode evidence, sometimes
// formatted across several lines. Find the single if-condition that contains BOTH mining and the
// RapidOCR preference and replace the whole condition, not just one textual spelling of it.
if (!capture.includes('if (mining && cfg.rapidOcr !== false) {')) {
  const ifRe = /if\s*\(([\s\S]{0,500}?)\)\s*\{/g;
  const matches = [];
  let m;
  while ((m = ifRe.exec(capture))) {
    const cond = m[1];
    if (/\bmining\b/.test(cond) && /cfg\.rapidOcr\s*!==\s*false/.test(cond)) {
      matches.push({ start: m.index, end: ifRe.lastIndex, text: m[0], cond });
    }
  }
  must(matches.length === 1,
    `RapidOCR mining gate: expected exactly one legacy mining+rapidOcr if, found ${matches.length}`);
  const g = matches[0];
  capture = capture.slice(0, g.start) + 'if (mining && cfg.rapidOcr !== false) {' + capture.slice(g.end);
}

// Fast cadence follows upstream: parsed signature is proof; scanHud text is only an early hint.
if (!capture.includes('else if (mining && (read.scanHud || typeof read.signature === "number")) fastUntil = Date.now() + FAST_WINDOW_MS;')) {
  const cadence = /else if \(mining && [^\n]+\) fastUntil = Date\.now\(\) \+ FAST_WINDOW_MS;/;
  must(cadence.test(capture), 'fast-poll gate: could not find an old cadence expression to converge');
  capture = capture.replace(cadence,
    'else if (mining && (read.scanHud || typeof read.signature === "number")) fastUntil = Date.now() + FAST_WINDOW_MS;');
}

// Make the intended contract mechanically checkable in the packaged artifact.
if (!capture.includes('ARCHVERSE_043_MINING_GATE')) {
  const anchor = 'const locked = mining && sigBox && Date.now() - sigBoxAt < SIG_LOCK_MS;';
  must(capture.includes(anchor), 'mining convergence marker anchor missing');
  capture = capture.replace(anchor,
    '// ARCHVERSE_043_MINING_GATE: radar is telemetry only; cropped OCR is armed by mining itself.\n      ' + anchor);
}

// Packaged Linux RapidOCR does not live in app.asar. It uses the isolated child and real node_modules
// paths, so report worker/model startup failures instead of applying the Windows app.asar rewrite.
if (!capture.includes('function reportLinuxRapidFailure(')) {
  const anchor = 'let _rapidWarningShown = false;';
  must(capture.includes(anchor), 'RapidOCR warning anchor missing');
  capture = capture.replace(anchor, `let sidecarPort043 = null;\nlet lastRapidFailure043 = null;\nfunction reportLinuxRapidFailure(reason) {\n  const text = String(reason || '');\n  if (text === lastRapidFailure043) return;\n  lastRapidFailure043 = text;\n  if (!sidecarPort043) return;\n  fetch(\`http://127.0.0.1:\${sidecarPort043}/api/ocr/rapid-failure\`, {\n    method: 'POST',\n    headers: { 'Content-Type': 'application/json' },\n    body: JSON.stringify({ reason: text }),\n    signal: AbortSignal.timeout(8000),\n  }).catch(() => {});\n}\n\n${anchor}`);

  const startAnchor = 'function startFabCapture({ port, configDir, onStatus, devTools = false }) {';
  must(capture.includes(startAnchor), 'startFabCapture anchor missing');
  capture = capture.replace(startAnchor, `${startAnchor}\n  sidecarPort043 = port;`);

  // Attach to the semantic catch block instead of the warning text: the shipped Alpha 22 shell and
  // branch copies use slightly different wording, but both funnel optional worker failures here.
  const optionalCatch = /(async function ocrRapidLinesOptional\([\s\S]{0,1200}?catch \(error\) \{)/;
  must(optionalCatch.test(capture), 'RapidOCR optional failure catch block missing');
  capture = capture.replace(optionalCatch,
    `$1\n    reportLinuxRapidFailure(\`Text recognition could not start — \${String(error?.message || error).slice(0, 200)}. Mining call-outs and the contract scanner may not work until this is fixed.\`);`);
}

must(capture.includes('if (mining && cfg.rapidOcr !== false) {'), 'mining RapidOCR is still gated by something besides mining + preference');
must(capture.includes('const locked = mining && sigBox && Date.now() - sigBoxAt < SIG_LOCK_MS;'), 'signature lock still depends on scan-mode detector');
must(!capture.includes('const locked = mining && archScanModeRead.active'), 'radar detector still gates signature lock');
must(capture.includes('const needGeneric = fab || miss || claim || payout;'), 'generic OCR still carries mining/radar gate');
must(capture.includes('typeof read.signature === "number"'), 'parsed signature does not drive fast cadence');
must(capture.includes('Math.round(lastTickMs * 1.5)'), 'self-tuning mining cadence missing');
must(capture.includes('reportLinuxRapidFailure(`Text recognition could not start'), 'RapidOCR failure does not reach sidecar reporting');
write(capturePath, capture);

let main = read(mainPath);
// 0.1.43 drag-lock recovery. The calibration fixes should lower the lock normally; this watchdog is
// the independent backstop so a missed pointerup/cancel cannot leave the full canvas eating input.
if (!main.includes('drag lock held 30s')) {
  const decl = 'let dragging = false;';
  must(main.includes(decl), 'dragging state declaration missing');
  main = main.replace(decl, `${decl}\nlet dragLockWatchdog043 = null; // 0.1.43 recovery backstop`);

  const handler = /ipcMain\.on\("overlay:drag-lock", \(_e, on\) => \{\n\s*dragging = !!on;/;
  must(handler.test(main), 'overlay:drag-lock handler missing');
  main = main.replace(handler, (m) => `${m}\n    clearTimeout(dragLockWatchdog043);\n    dragLockWatchdog043 = null;\n    if (dragging) {\n      dragLockWatchdog043 = setTimeout(() => {\n        if (!dragging) return;\n        console.error('[overlay] drag lock held 30s — releasing it; the page never sent pointerup');\n        dragging = false;\n        applyMouse();\n      }, 30_000);\n      dragLockWatchdog043.unref?.();\n    }`);
}

// Flatpak/KWin focus handoff. The first click back into Star Citizen can blur Electron before the
// global mouse-down path gets a chance to call releaseFocusLatchToGame(). Alpha 22's desktop-focus
// cleanup then cleared the latch but deliberately left focus where the compositor happened to put
// it. When that blur target is positively identified as Star Citizen, clear click ownership first
// and then restore the exact pre-overlay native window captured on F-down. External desktop apps
// still keep their own focus; no click is ever synthesized into Star Citizen.
if (!main.includes('ARCHVERSE_FLATPAK_GAME_FOCUS_HANDOFF')) {
  const oldHandoff = `    const active = overlayWindows.activeWindowDetails?.();\n    if (active && overlayWindows.isOwnOverlayWindow?.(active)) return;\n    const reason = overlayWindows.isStarCitizenDirectlyActive?.()\n      ? "Star Citizen clicked"\n      : \`external window clicked\${active?.title ? \`: \${active.title}\` : ""}\`;\n    releaseOverlayOwnershipToDesktop(reason);`;
  const newHandoff = `    const active = overlayWindows.activeWindowDetails?.();\n    if (active && overlayWindows.isOwnOverlayWindow?.(active)) return;\n    const gameActive = !!overlayWindows.isStarCitizenDirectlyActive?.();\n    const reason = gameActive\n      ? "Star Citizen clicked"\n      : \`external window clicked\${active?.title ? \`: \${active.title}\` : ""}\`;\n    const released = releaseOverlayOwnershipToDesktop(reason);\n    if (gameActive && released) {\n      // ARCHVERSE_FLATPAK_GAME_FOCUS_HANDOFF: click-through must exist before restoring the game.\n      setTimeout(() => {\n        if (overlayExclusiveInteractionActive()) return;\n        if (!overlayWindows.starCitizenProcessRunning?.()) return;\n        restoreLinuxPreviousWindow();\n        console.log("[game-focus] Star Citizen click handoff restored the pre-overlay game focus");\n      }, 35);\n    }`;
  main = replaceOnce(main, oldHandoff, newHandoff, 'Star Citizen focus handoff');

  const oldDesktopLog = 'if (had) console.log(`[desktop-focus] overlay input ownership released (${reason}); desktop keeps focus`);';
  const newDesktopLog = 'if (had) console.log(`[desktop-focus] overlay input ownership released (${reason}); click-through restored`);';
  main = replaceOnce(main, oldDesktopLog, newDesktopLog, 'desktop focus release log');
}

// Temporary 0.1.43 implementation. The generic Linux policy pass below promotes this into the
// version-independent contract and verifies the final names/semantics used by the packaged build.
if (!main.includes('ARCHVERSE_FLATPAK_HOVER_SCOPED_LATCH')) {
  const lifecycleAnchor = 'let linuxScLifecycleTimer = null;';
  must(main.includes(lifecycleAnchor), 'Linux lifecycle timer anchor missing for hover-scoped latch');
  const hoverLatch = `let postReleaseHoverTimer043 = null;\nlet postReleaseHoverMissSince043 = 0;\nconst POST_RELEASE_HOVER_MISS_MS_043 = 90;\n\nfunction postReleasePointerInsideWidget043() {\n  let p = null;\n  try { p = overlayWindows.pointerLocation?.(); } catch {}\n  if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) {\n    try { p = screen.getCursorScreenPoint(); } catch {}\n  }\n  if (!p || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return true;\n  try { return !!overlayRegionAtPoint({ x: Number(p.x), y: Number(p.y) }); } catch { return true; }\n}\n\nfunction tickPostReleaseHoverLatch043() {\n  // ARCHVERSE_FLATPAK_HOVER_SCOPED_LATCH: after F-up, a clicked widget owns focus only while\n  // the pointer remains inside any classified overlay widget. Fail-safe on unknown pointer state.\n  if (fHoverHeld || !overlayInteractionLatched || modalOpen || dragging || moveMode || miningMoveMode) {\n    postReleaseHoverMissSince043 = 0;\n    return;\n  }\n  if (postReleasePointerInsideWidget043()) {\n    postReleaseHoverMissSince043 = 0;\n    return;\n  }\n  const now = Date.now();\n  if (!postReleaseHoverMissSince043) {\n    postReleaseHoverMissSince043 = now;\n    return;\n  }\n  if (now - postReleaseHoverMissSince043 < POST_RELEASE_HOVER_MISS_MS_043) return;\n  postReleaseHoverMissSince043 = 0;\n  const released = releaseOverlayOwnershipToDesktop("pointer left all widgets after F release");\n  if (!released) return;\n  setTimeout(() => {\n    if (overlayExclusiveInteractionActive()) return;\n    restoreLinuxPreviousWindow();\n    console.log("[focus-latch] pointer left all widgets after F release; click-through restored and previous focus returned");\n  }, 35);\n}\n\nfunction startPostReleaseHoverLatch043() {\n  if (postReleaseHoverTimer043) return;\n  postReleaseHoverTimer043 = setInterval(tickPostReleaseHoverLatch043, 32);\n  postReleaseHoverTimer043.unref?.();\n}\n\nfunction stopPostReleaseHoverLatch043() {\n  if (postReleaseHoverTimer043) clearInterval(postReleaseHoverTimer043);\n  postReleaseHoverTimer043 = null;\n  postReleaseHoverMissSince043 = 0;\n}\n\n${lifecycleAnchor}`;
  main = main.replace(lifecycleAnchor, hoverLatch);

  const startAnchor = 'function startLinuxDesktopFocusWatch() {\n  if (process.platform !== "linux" || linuxScLifecycleTimer) return;';
  const startReplacement = 'function startLinuxDesktopFocusWatch() {\n  if (process.platform !== "linux" || linuxScLifecycleTimer) return;\n  startPostReleaseHoverLatch043();';
  main = replaceOnce(main, startAnchor, startReplacement, 'hover-scoped latch startup');

  const stopAnchor = 'function stopLinuxDesktopFocusWatch() {\n  if (linuxScLifecycleTimer) clearInterval(linuxScLifecycleTimer);';
  const stopReplacement = 'function stopLinuxDesktopFocusWatch() {\n  stopPostReleaseHoverLatch043();\n  if (linuxScLifecycleTimer) clearInterval(linuxScLifecycleTimer);';
  main = replaceOnce(main, stopAnchor, stopReplacement, 'hover-scoped latch shutdown');
}

must(main.includes('drag lock held 30s'), '0.1.43 drag-lock watchdog missing after convergence');
must(main.includes('ARCHVERSE_FLATPAK_GAME_FOCUS_HANDOFF'), 'Flatpak Star Citizen focus handoff recovery missing after convergence');
must(main.includes('[game-focus] Star Citizen click handoff restored the pre-overlay game focus'), 'game focus handoff diagnostic missing');
write(mainPath, main);

// Every Linux Electron convergence ends by enforcing the version-independent interaction policy.
// This is deliberately separate from 0.1.43 so future upstream upgrades cannot silently change the
// held-F/widget-latch/focus-return behavior. If upstream refactors the required hooks, packaging fails.
const policyScript = path.join(__dirname, 'enforce-linux-interaction-policy.cjs');
const policy = spawnSync(process.execPath, [policyScript, mainPath], { stdio: 'inherit' });
must(policy.status === 0, `durable Linux interaction policy failed (status ${policy.status})`);
main = read(mainPath);
must(main.includes('ARCHVERSE_LINUX_HOVER_SCOPED_LATCH'), 'durable Linux hover-scoped latch policy missing after enforcement');
must(main.includes('[linux-interaction] pointer left all widgets; overlay released and previous focus restored'), 'durable Linux focus-return diagnostic missing after enforcement');

console.log('0.1.43 Electron convergence applied and verified');
