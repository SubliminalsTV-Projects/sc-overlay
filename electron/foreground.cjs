// Who's in front? — one long-lived helper instead of a process per question.
//
// Two features need this continuously: the OCR loop (only ever look at the screen while Star
// Citizen is focused) and hold-to-interact (only demand the hold while the GAME is focused —
// on the desktop the overlay should just behave like a normal window, so the interact key is
// never pressed where it would type into Discord or a browser).
//
// It used to be an `execFile("powershell", …)` per ask, on a 3s timer — ~20 process launches a
// minute to read one HWND. This spawns ONE PowerShell that loops and prints only when the answer
// CHANGES, so the steady state is a sleeping process and an idle pipe. Everything else reads a
// cached value for free.
//
// 🔑 The process name is resolved only when the HWND changes — Get-Process every tick is the
// expensive part of the naive loop, and the foreground window is the same one for minutes at a time.
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const POLL_MS = 250;      // how often the helper looks; cheap enough to be invisible
const RESTART_MS = 4000;  // backoff if the helper dies

const ps1 = path.join(os.tmpdir(), "sc-fgwatch.ps1");
const SCRIPT = [
  'Add-Type @"',
  "using System;using System.Runtime.InteropServices;",
  "public class FGW{",
  ' [DllImport("user32.dll")]public static extern IntPtr GetForegroundWindow();',
  ' [DllImport("user32.dll")]public static extern int GetWindowThreadProcessId(IntPtr h,out int pid);',
  " [StructLayout(LayoutKind.Sequential)]public struct RECT{public int Left,Top,Right,Bottom;}",
  ' [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out RECT r);',
  "}",
  '"@',
  "$last='';$lastH=[IntPtr]::Zero;$name=''",
  "while($true){",
  "  $h=[FGW]::GetForegroundWindow()",
  // Only pay for Get-Process when the window itself changed.
  "  if($h -ne $lastH){",
  "    $lastH=$h;$procId=0;[void][FGW]::GetWindowThreadProcessId($h,[ref]$procId)",
  "    $name=try{(Get-Process -Id $procId -ErrorAction Stop).ProcessName}catch{''}",
  "  }",
  "  $r=New-Object FGW+RECT;[void][FGW]::GetWindowRect($h,[ref]$r)",
  '  $line="$name|$($r.Left)|$($r.Top)|$([int]($r.Right-$r.Left))|$([int]($r.Bottom-$r.Top))"',
  "  if($line -ne $last){$last=$line;[Console]::Out.WriteLine($line);[Console]::Out.Flush()}",
  `  Start-Sleep -Milliseconds ${POLL_MS}`,
  "}",
].join("\n");

// ── In-process fast path (0.1.41) ───────────────────────────────────────────────────────────
// koffi FFI straight to user32/kernel32 — the exact three calls the PowerShell helper made,
// minus the ~40-68 MB PowerShell host it made them from. The helper below is NOT dead code:
// it is the fallback if koffi fails to load or a call ever throws, so a broken native module
// degrades to the shipped 0.1.40 behavior rather than to blindness (hold-to-interact and the
// OCR gate both read this).
let native = null;
try {
  const koffi = require("koffi");
  const user32 = koffi.load("user32.dll");
  const kernel32 = koffi.load("kernel32.dll");
  const GetForegroundWindow = user32.func("void* GetForegroundWindow()");
  const GetWindowThreadProcessId = user32.func("uint32 GetWindowThreadProcessId(void* h, _Out_ uint32* pid)");
  koffi.struct("FGRECT", { left: "long", top: "long", right: "long", bottom: "long" });
  const GetWindowRect = user32.func("bool GetWindowRect(void* h, _Out_ FGRECT* r)");
  const OpenProcess = kernel32.func("void* OpenProcess(uint32 access, bool inherit, uint32 pid)");
  const CloseHandle = kernel32.func("bool CloseHandle(void* h)");
  const QueryFullProcessImageNameW = kernel32.func("bool QueryFullProcessImageNameW(void* h, uint32 flags, void* buf, _Inout_ uint32* size)");
  const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
  let lastHwnd = null; // resolve the process name only when the HWND changes — same economy as the helper
  let lastName = "";
  native = {
    read() {
      const h = GetForegroundWindow();
      if (!h) return { name: "", rect: null };
      const addr = koffi.address(h);
      if (addr !== lastHwnd) {
        lastHwnd = addr;
        lastName = "";
        const pidOut = [0];
        GetWindowThreadProcessId(h, pidOut);
        if (pidOut[0]) {
          const ph = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pidOut[0]);
          if (ph) {
            const buf = Buffer.alloc(1040);
            const size = [519];
            if (QueryFullProcessImageNameW(ph, 0, buf, size)) {
              // Match the helper's Get-Process .ProcessName: basename, no extension.
              const full = buf.toString("utf16le", 0, size[0] * 2);
              lastName = path.basename(full).replace(/\.exe$/i, "");
            }
            CloseHandle(ph);
          }
        }
      }
      const r = {};
      let rect = null;
      if (GetWindowRect(h, r)) {
        const w = r.right - r.left, ht = r.bottom - r.top;
        if (w > 0 && ht > 0) rect = { x: r.left, y: r.top, width: w, height: ht };
      }
      return { name: lastName, rect };
    },
  };
} catch {
  native = null; // no koffi (or no prebuild for this machine) — the PowerShell helper takes over
}

let proc = null;
let nativeTimer = null;
let lastNativeLine = null;
let stopped = false;
let restartT = null;
let current = { name: "", rect: null };
let everRead = false; // until the helper speaks once, callers should fall back
const listeners = [];
// Who currently needs the answer. A PowerShell host is ~40MB resident, and BOTH consumers are
// opt-in (hold-to-interact, screen reading) — so with neither switched on, this must cost nothing
// at all rather than idle in the background for a question nobody is asking.
const wanted = new Set();

function emit() {
  for (const cb of listeners) { try { cb(current); } catch { /* a listener threw — not our problem */ } }
}

function handleLine(line) {
  const p = String(line).trim().split("|");
  if (p.length < 5) return;
  const w = +p[3], h = +p[4];
  current = {
    name: p[0] || "",
    rect: w > 0 && h > 0 ? { x: +p[1], y: +p[2], width: w, height: h } : null,
  };
  everRead = true;
  emit();
}

function start() {
  if (stopped) return;
  if (native) {
    if (nativeTimer) return;
    nativeTimer = setInterval(() => {
      let next;
      try {
        next = native.read();
      } catch {
        // A native call threw — permanently hand this session to the PowerShell helper.
        native = null;
        clearInterval(nativeTimer);
        nativeTimer = null;
        lastNativeLine = null;
        start();
        return;
      }
      everRead = true;
      const line = next.rect
        ? `${next.name}|${next.rect.x}|${next.rect.y}|${next.rect.width}|${next.rect.height}`
        : `${next.name}|`;
      if (line !== lastNativeLine) { lastNativeLine = line; current = next; emit(); }
    }, POLL_MS);
    return;
  }
  if (proc) return;
  try { fs.writeFileSync(ps1, SCRIPT); } catch { return; } // no temp dir — callers fall back
  try {
    proc = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], {
      windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    });
  } catch { proc = null; return; }
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    if (buf.length > 4096) buf = ""; // a wedged helper can't grow us a buffer
  });
  const gone = () => {
    proc = null;
    // Don't leave the app permanently blind if the helper is killed — but don't spin either.
    if (!stopped && !restartT) restartT = setTimeout(() => { restartT = null; start(); }, RESTART_MS);
  };
  proc.on("exit", gone);
  proc.on("error", gone);
}

function halt() {
  if (nativeTimer) { clearInterval(nativeTimer); nativeTimer = null; lastNativeLine = null; }
  if (restartT) { clearTimeout(restartT); restartT = null; }
  if (proc) { try { proc.kill(); } catch { /* already gone */ } proc = null; }
  everRead = false;            // stale the moment we stop looking
  current = { name: "", rect: null };
}

function stop() { stopped = true; wanted.clear(); halt(); }

/**
 * Declare whether a feature needs foreground tracking. The helper runs only while at least one
 * does — `want("ocr", false)` after the last consumer switches off puts us back to zero cost.
 */
function want(reason, on) {
  if (on) wanted.add(reason); else wanted.delete(reason);
  if (wanted.size && !stopped) start();
  else if (!wanted.size) halt();
}

/** Last known foreground window: { name, rect }. `name` is "" until the helper has answered. */
function foreground() { return current; }
/** Has the helper reported at all? False → the caller should use its own slow path. */
function ready() { return everRead; }
/** True while Star Citizen is the focused application. */
function gameInFront() { return /^StarCitizen$/i.test(current.name); }
/** Called on every CHANGE of foreground window (or its rect). */
function onChange(cb) { if (typeof cb === "function") listeners.push(cb); }

module.exports = { want, stop, foreground, ready, gameInFront, onChange };
