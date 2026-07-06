// Fabricator screen-capture loop (opt-in).
//
// On a low-frequency poll, and ONLY while Star Citizen is the FOREGROUND window
// (privacy: we never capture/OCR any other app), grab a full screenshot and ask the
// sidecar's /api/screen-read to OCR it. If the fabricator is showing an item we don't
// have a capture for yet, crop its render and save it locally; a later step uploads
// these to subliminal.gg. A tracked-mission read is logged for the picker wiring.
//
// This runs only in the Electron main process (needs desktopCapturer + nativeImage).

const { desktopCapturer, screen, nativeImage } = require("electron");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const POLL_MS = 5000;

// Return the foreground window's process name (e.g. "StarCitizen"), or "" on failure.
function foregroundProcess() {
  return new Promise((resolve) => {
    const ps = [
      "$s='[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow();",
      "[DllImport(\"user32.dll\")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);';",
      "$t=Add-Type -MemberDefinition $s -Name U -Namespace W -PassThru;",
      "$h=$t::GetForegroundWindow(); $procId=0; [void]$t::GetWindowThreadProcessId($h,[ref]$procId);",
      "try { (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { '' }",
    ].join(" ");
    execFile("powershell", ["-NoProfile", "-Command", ps], { windowsHide: true, timeout: 4000 }, (err, out) => {
      resolve(err ? "" : String(out).trim());
    });
  });
}

// Capture the primary display at full physical resolution → nativeImage.
async function captureScreen() {
  const d = screen.getPrimaryDisplay();
  const width = Math.round(d.size.width * d.scaleFactor);
  const height = Math.round(d.size.height * d.scaleFactor);
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width, height } });
  return sources[0] ? sources[0].thumbnail : null;
}

// Is an item actually rendered in the crop, or did we catch the fabricator mid-load
// (just the teal background)? The 3D preview streams in when an item is selected; an
// empty crop is a smooth gradient with no specular highlights. Real renders always have
// some bright pixels (measured: empty = 0.00%, every real item >= 0.17%). Gate at 0.05%
// so we DON'T save (and dedup-lock) an empty frame — a later poll retries once it loads.
function hasRender(image) {
  const bmp = image.getBitmap();          // BGRA, 4 bytes/pixel
  const total = bmp.length / 4;
  if (total < 1) return false;
  let bright = 0;
  for (let i = 0; i < bmp.length; i += 4) {
    const lum = 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2];
    if (lum > 150) bright++;
  }
  return bright / total > 0.0005;
}

const SITE = "https://subliminal.gg";

function readConfig(configDir) {
  try { return JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8")); }
  catch { return {}; }
}

/** Start the opt-in capture loop. `configDir` = the %APPDATA%/sc-blueprint-tracker dir. */
function startFabCapture({ port, configDir }) {
  const captureDir = path.join(configDir, "fab-captures");
  const tmpShot = path.join(os.tmpdir(), "sc-fab-shot.png");
  let busy = false;
  let lastMission = "";       // last mission title sent (throttle screen-read posts)
  const uploaded = new Set(); // items pushed to the site this session
  let remoteHave = null;      // set of items the site already has (dedup); fetched once

  // What does the site already have? Skip capturing those. Fetched lazily, best-effort.
  async function ensureRemoteHave() {
    if (remoteHave) return remoteHave;
    try {
      const r = await fetch(`${SITE}/api/sc/fab-needed`);
      const j = await r.json();
      remoteHave = new Set(Array.isArray(j.have) ? j.have : []);
    } catch { remoteHave = new Set(); }
    return remoteHave;
  }

  async function upload(item, jpeg, token) {
    try {
      const r = await fetch(`${SITE}/api/sc/fab-image?item=${encodeURIComponent(item)}`, {
        method: "POST",
        headers: { "Content-Type": "image/jpeg", Authorization: `Bearer ${token}` },
        body: jpeg,
      });
      if (r.ok) { uploaded.add(item); remoteHave?.add(item); return true; }
      console.error(`[fab-capture] upload ${item} -> HTTP ${r.status}`);
    } catch (e) { console.error("[fab-capture] upload error:", e && e.message); }
    return false;
  }

  async function tick() {
    const cfg = readConfig(configDir);
    if (busy || cfg.fabCapture !== true) return;
    const proc = await foregroundProcess();
    if (!/^StarCitizen$/i.test(proc)) return; // only ever look at SC
    busy = true;
    try {
      const have = await ensureRemoteHave();
      const shot = await captureScreen();
      if (!shot) return;
      fs.writeFileSync(tmpShot, shot.toPNG());
      const resp = await fetch(`http://localhost:${port}/api/screen-read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: tmpShot }),
      });
      const read = await resp.json();
      if (read.kind === "fabricator" && read.item) {
        const item = read.item;
        // Dedup: already uploaded this session, or the site already has it.
        if (uploaded.has(item) || have.has(item)) return;
        const c = read.crop;
        const cropped = shot.crop({ x: c.x, y: c.y, width: c.w, height: c.h });
        if (!hasRender(cropped)) {
          console.log(`[fab-capture] ${read.name}: render not loaded yet, will retry`);
          return;
        }
        // Opaque teal kiosk background -> JPEG (small, fits the ingest cap).
        const jpeg = cropped.toJPEG(82);
        fs.mkdirSync(captureDir, { recursive: true });
        fs.writeFileSync(path.join(captureDir, `${item}.jpg`), jpeg);
        if (cfg.syncToken) {
          const ok = await upload(item, jpeg, cfg.syncToken);
          console.log(`[fab-capture] ${ok ? "uploaded" : "saved (upload failed)"} ${read.name} (${item})`);
        } else {
          console.log(`[fab-capture] saved ${read.name} (${item}) — no sync token, not uploaded`);
        }
      } else if (read.kind === "mission" && read.titleRaw && read.titleRaw !== lastMission) {
        // Tell the tracker which mission is pinned in-game (ground truth the log lacks).
        lastMission = read.titleRaw;
        try {
          await fetch(`http://localhost:${port}/api/missions/screen`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: read.titleRaw }),
          });
        } catch { /* best effort */ }
      }
    } catch (e) {
      console.error("[fab-capture] tick error:", e && e.message);
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  console.log("[fab-capture] loop armed (opt-in via config.fabCapture)");
  return () => clearInterval(timer);
}

module.exports = { startFabCapture };
