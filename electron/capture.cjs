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

const POLL_MS = 3000;

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

// Crop tight around the SUBJECT and re-centre on it. The anchor crop's x-span runs
// name-left..X-close, which is NOT centred on the 3D render, so a symmetric trim around the
// frame midline would preserve any lean (dead space on the opposite side) and keep the kiosk's
// category-tab sliver stuck at the far-left edge. Instead we find the item's own L/R extent
// and crop to it with equal margins. Item pixels = far from the sampled teal bg; a column
// counts if item in >10% of rows — then we keep only the DOMINANT contiguous block, so the
// tab rail (thin, at the edge, gap-separated from the render) is excluded, not just un-stretched.
function centerTighten(image, margin = 20, tol = 48) {
  const { width: w, height: h } = image.getSize();
  if (w < 40 || h < 40) return image;
  const bmp = image.getBitmap(); // BGRA
  const med = (a) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };
  const sb = [], sg = [], sr = [];
  for (const [cx, cy] of [[4, 4], [w - 9, 4], [4, h - 9], [w - 9, h - 9]]) {
    for (let dy = 0; dy < 8; dy++) for (let dx = 0; dx < 8; dx++) {
      const i = ((cy + dy) * w + (cx + dx)) * 4;
      sb.push(bmp[i]); sg.push(bmp[i + 1]); sr.push(bmp[i + 2]);
    }
  }
  const bg = { b: med(sb), g: med(sg), r: med(sr) };
  const rowThresh = h * 0.10;
  const isItem = new Array(w);
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * 4;
      if (Math.abs(bmp[i] - bg.b) + Math.abs(bmp[i + 1] - bg.g) + Math.abs(bmp[i + 2] - bg.r) > tol) cnt++;
    }
    isItem[x] = cnt > rowThresh;
  }
  // Dominant contiguous block, bridging gaps <= maxGap (a render's internal background
  // shouldn't split it). The tab rail is a thin far-edge cluster separated by a wide gap,
  // so it becomes its own tiny segment and loses to the render.
  const maxGap = Math.round(w * 0.06);
  let left = -1, right = -1, best = 0;
  for (let x = 0; x < w; ) {
    if (!isItem[x]) { x++; continue; }
    let segL = x, segR = x, cnt = 0, gap = 0;
    while (x < w && gap <= maxGap) {
      if (isItem[x]) { segR = x; cnt++; gap = 0; } else { gap++; }
      x++;
    }
    if (cnt > best) { best = cnt; left = segL; right = segR; }
  }
  if (left < 0 || right - left < 20) return image;
  const nl = Math.max(0, left - margin), nr = Math.min(w, right + margin);
  const nw = nr - nl;
  if (nw > 40 && nw < w) return image.crop({ x: nl, y: 0, width: nw, height: h });
  return image;
}

function readConfig(configDir) {
  try { return JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8")); }
  catch { return {}; }
}

/** Start the opt-in capture loop. `configDir` = the %APPDATA%/sc-blueprint-tracker dir. */
function startFabCapture({ port, configDir }) {
  const captureDir = path.join(configDir, "fab-captures");
  const shotsDir = path.join(configDir, "fab-shots"); // full uncropped frames (mineable)
  const tmpShot = path.join(os.tmpdir(), "sc-fab-shot.png");
  let busy = false;
  let lastMission = "";       // last mission title sent (throttle screen-read posts)
  let pendingItem = null;     // item seen last tick, awaiting a settle poll before capture
  const uploaded = new Set(); // items pushed to the site this session
  let remoteHave = null;      // set of items the site already has (dedup)
  let remoteHaveAt = 0;       // when remoteHave was last fetched
  const REMOTE_TTL_MS = 3 * 60_000; // re-fetch the site's have-list this often

  // What does the site already have? Skip capturing those. Re-fetched every REMOTE_TTL_MS so a
  // server-side delete/replace (or a failed upload) becomes capturable again WITHOUT restarting.
  async function ensureRemoteHave() {
    if (remoteHave && Date.now() - remoteHaveAt < REMOTE_TTL_MS) return remoteHave;
    try {
      const r = await fetch(`${SITE}/api/sc/fab-needed`);
      const j = await r.json();
      remoteHave = new Set(Array.isArray(j.have) ? j.have : []);
      remoteHaveAt = Date.now();
      // Forget session-uploads the server no longer has (deleted or upload failed) so they retry.
      for (const it of uploaded) if (!remoteHave.has(it)) uploaded.delete(it);
    } catch { if (!remoteHave) remoteHave = new Set(); }
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
        if (uploaded.has(item) || have.has(item)) { pendingItem = null; return; }
        // Settle: the kiosk's 3D render fades in over ~1-2s, so a first-glimpse capture
        // can come out half-loaded / see-through. Require the item to still be on screen
        // a poll later (this shot) before capturing, giving the render time to finish.
        if (pendingItem !== item) {
          pendingItem = item;
          console.log(`[fab-capture] ${read.name}: waiting for render to settle`);
          return;
        }
        const c = read.crop;
        const cropped = centerTighten(shot.crop({ x: c.x, y: c.y, width: c.w, height: c.h }));
        if (!hasRender(cropped)) {
          console.log(`[fab-capture] ${read.name}: render not loaded yet, will retry`);
          return; // keep pendingItem so the next poll retries
        }
        // Opaque teal kiosk background -> JPEG (small, fits the ingest cap).
        const jpeg = cropped.toJPEG(82);
        fs.mkdirSync(captureDir, { recursive: true });
        fs.writeFileSync(path.join(captureDir, `${item}.jpg`), jpeg);
        // Keep the FULL uncropped frame too — it carries the materials list, stats,
        // fabrication time + recipe we may mine later. One per item.
        fs.mkdirSync(shotsDir, { recursive: true });
        fs.writeFileSync(path.join(shotsDir, `${item}.jpg`), shot.toJPEG(85));
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

module.exports = { startFabCapture, centerTighten };
