#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const file = process.argv[2];
if (!file) {
  console.error('usage: converge-server-043.cjs <server.mjs>');
  process.exit(2);
}

let src = fs.readFileSync(file, 'utf8');
const must = (cond, msg) => { if (!cond) throw new Error(msg); };

// Flatpak persists state under the launcher-selected XDG path, not HOME/APPDATA. Keep this
// environment override load-bearing so Arch and Fedora hosts use the same sandbox-safe location.
if (!src.includes('process.env.SC_TRACKER_CONFIG_DIR ||')) {
  const oldUserDir = 'var userDir = join11(process.env.APPDATA ?? process.env.HOME ?? ".", "sc-blueprint-tracker");';
  must(src.includes(oldUserDir), 'server userDir anchor missing');
  src = src.replace(oldUserDir,
    'var userDir = process.env.SC_TRACKER_CONFIG_DIR || join11(process.env.APPDATA ?? process.env.HOME ?? ".", "sc-blueprint-tracker");');
}

// Upstream 0.1.43 added RapidOCR failure precedence. Preserve that exactly: if Electron reports
// the Linux RapidOCR engine failed, diagnostics MUST remain red. Only after that check may Linux
// skip ocrSelfTest(), because that self-test is Windows.Media.Ocr/PowerShell and is not the engine
// the Flatpak uses.
if (!src.includes('ARCHVERSE_043_LINUX_OCR_HEALTH')) {
  const failureTail = '      signal: { spawnError: null, exitedBeforeReady: false, lastExitCode: null, everReady: false } };\n  }\n';
  const at = src.indexOf(failureTail);
  must(at >= 0, '0.1.43 rapidOcrFailure return block not found');

  const after = at + failureTail.length;
  const cacheNeedle = '  if (ocrHealth && Date.now() - ocrHealthAt < maxAgeMs) return ocrHealth;';
  const cacheAt = src.indexOf(cacheNeedle, after);
  must(cacheAt >= 0 && cacheAt - after < 600,
    'OCR health cache/self-test is not immediately downstream of RapidOCR failure precedence');

  const linux = `  // ARCHVERSE_043_LINUX_OCR_HEALTH: RapidOCR failure above stays authoritative.\n  // The remaining upstream self-test is Windows.Media.Ocr via PowerShell, which the Flatpak\n  // intentionally does not use. A healthy packaged RapidOCR engine is verified separately by CI.\n  if (process.platform !== "win32") {\n    return { ok: true, matched: true, skipped: true, lines: 0, text: "",\n      ranAt: new Date().toISOString(), ms: 0, reason: null,\n      engine: "ArchVerse Linux RapidOCR (Electron capture)",\n      signal: { spawnError: null, exitedBeforeReady: false, lastExitCode: null, everReady: true } };\n  }\n`;
  src = src.slice(0, cacheAt) + linux + src.slice(cacheAt);
}

const failurePos = src.indexOf('if (rapidOcrFailure) {');
const linuxPos = src.indexOf('ARCHVERSE_043_LINUX_OCR_HEALTH');
const selfTestPos = src.indexOf('ocrHealth = await ocrSelfTest();');
must(failurePos >= 0, 'rapidOcrFailure precedence missing');
must(linuxPos > failurePos, 'Linux OCR bypass incorrectly precedes RapidOCR failure check');
must(selfTestPos > linuxPos, 'Windows OCR self-test is not downstream of Linux bypass');
must(src.includes('process.env.SC_TRACKER_CONFIG_DIR ||'), 'Flatpak config-dir override missing');
must(src.includes('/api/ocr/rapid-failure'), '0.1.43 RapidOCR failure route missing');

fs.writeFileSync(file, src);
console.log('0.1.43 Linux sidecar OCR/config semantics converged and verified');
