#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

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

  const catchAnchor = 'console.warn("[ocr] RapidOCR worker unavailable; continuing with Tesseract fallback:", error?.message || error);';
  must(capture.includes(catchAnchor), 'RapidOCR optional failure catch anchor missing');
  capture = capture.replace(catchAnchor,
    `${catchAnchor}\n      reportLinuxRapidFailure(\`Text recognition could not start — \${String(error?.message || error).slice(0, 200)}. Mining call-outs and the contract scanner may not work until this is fixed.\`);`);
}

must(capture.includes('if (mining && cfg.rapidOcr !== false) {'), 'mining RapidOCR is still gated by something besides mining + preference');
must(capture.includes('const locked = mining && sigBox && Date.now() - sigBoxAt < SIG_LOCK_MS;'), 'signature lock still depends on scan-mode detector');
must(!capture.includes('const locked = mining && archScanModeRead.active'), 'radar detector still gates signature lock');
must(capture.includes('const needGeneric = fab || miss || claim || payout;'), 'generic OCR still carries mining/radar gate');
must(capture.includes('typeof read.signature === "number"'), 'parsed signature does not drive fast cadence');
must(capture.includes('Math.round(lastTickMs * 1.5)'), 'self-tuning mining cadence missing');
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
must(main.includes('drag lock held 30s'), '0.1.43 drag-lock watchdog missing after convergence');
write(mainPath, main);

console.log('0.1.43 Electron convergence applied and verified');
