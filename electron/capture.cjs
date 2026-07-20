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
  const { width: w, height: h } = image.getSize();
  const total = bmp.length / 4;
  if (total < 1 || w < 2) return false;
  const lumAt = (i) => 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2];
  let bright = 0;
  for (let i = 0; i < bmp.length; i += 4) if (lumAt(i) > 150) bright++;
  if (bright / total > 0.0005) return true; // specular highlights — most items load this way
  // Fallback for small, DARK items (fuel components, dark weapons): they add almost no bright
  // pixels (measured: 0.02% vs 0.25%+ for normal items) but still have hard silhouette edges an
  // empty mid-load teal gradient doesn't. Count horizontal neighbour luminance jumps > 24; a
  // smooth gradient stays near zero, a real render is well above (measured: dark item 0.14%).
  let edges = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w - 1; x++) {
      const i = row + x * 4;
      if (Math.abs(lumAt(i) - lumAt(i + 4)) > 24) edges++;
    }
  }
  return edges / total > 0.0006;
}

const SITE = "https://subliminal.gg";

// Crop tight around the SUBJECT and re-centre on it, on BOTH axes. The kiosk shows the item
// floating on a smooth teal glow with a faint backdrop grid. The old approach kept the item's
// extent by colour-distance from the corner background — but the glow ALSO differs from the
// corners, so for a small, dark item (e.g. fuel components) it locked onto the glow and left the
// item tiny + off-centre. Instead we locate the item by its EDGES: a real 3D render has hard
// silhouette/detail edges, while the glow is smooth and the grid is low-contrast. We take the
// dominant contiguous edge cluster's bounding box on x and y and crop to it with a small margin.
function centerTighten(image, margin = 22) {
  const { width: w, height: h } = image.getSize();
  if (w < 40 || h < 40) return image;
  const bmp = image.getBitmap(); // BGRA
  const lumAt = (x, y) => { const i = (y * w + x) * 4; return 0.114 * bmp[i] + 0.587 * bmp[i + 1] + 0.299 * bmp[i + 2]; };
  const T = 28; // edge threshold: above the faint backdrop grid (~10-15), at/below item silhouette
  const colE = new Int32Array(w), rowE = new Int32Array(h);
  let totalE = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const l = lumAt(x, y);
      const gx = x + 1 < w ? Math.abs(l - lumAt(x + 1, y)) : 0;
      const gy = y + 1 < h ? Math.abs(l - lumAt(x, y + 1)) : 0;
      if (gx > T || gy > T) { colE[x]++; rowE[y]++; totalE++; }
    }
  }
  if (totalE < 50) return image; // no discernible subject — leave the anchor crop as-is
  // Dominant contiguous run in an edge-count projection (bridging small gaps), so a stray UI
  // sliver or grid speck loses to the item cluster. `span` is the perpendicular dimension.
  const domRun = (arr, n, span) => {
    const floor = Math.max(2, Math.round(0.008 * span)); // a line needs this many edge px to count
    const maxGap = Math.max(6, Math.round(n * 0.06));
    let bestL = -1, bestR = -1, bestSum = 0, i = 0;
    while (i < n) {
      if (arr[i] < floor) { i++; continue; }
      let segL = i, segR = i, sum = 0, gap = 0;
      while (i < n && gap <= maxGap) {
        if (arr[i] >= floor) { segR = i; sum += arr[i]; gap = 0; } else { gap++; }
        i++;
      }
      if (sum > bestSum) { bestSum = sum; bestL = segL; bestR = segR; }
    }
    return [bestL, bestR];
  };
  const [xL, xR] = domRun(colE, w, h);
  const [yT, yB] = domRun(rowE, h, w);
  if (xL < 0 || yT < 0) return image;
  const nl = Math.max(0, xL - margin), nr = Math.min(w, xR + 1 + margin);
  const nt = Math.max(0, yT - margin), nb = Math.min(h, yB + 1 + margin);
  const nw = nr - nl, nh = nb - nt;
  if (nw >= 24 && nh >= 24 && (nw < w || nh < h)) return image.crop({ x: nl, y: nt, width: nw, height: nh });
  return image;
}

function readConfig(configDir) {
  try { return JSON.parse(fs.readFileSync(path.join(configDir, "config.json"), "utf8")); }
  catch { return {}; }
}

/** Start the opt-in capture loop. `configDir` = the %APPDATA%/sc-blueprint-tracker dir.
 *  `onStatus(s)` (optional) reports OCR activity to the overlay: {state} for
 *  off/idle/watching/settling, {state:"mission",title}, {state:"captured",name,uploaded},
 *  {state:"have",name} (recognized, but the site already has the image — skipped),
 *  {state:"render",name} (recognized, waiting for the 3D render to finish loading), or
 *  {state:"unresolved",nameRaw} (in the kiosk but the item couldn't be identified). */
function startFabCapture({ port, configDir, onStatus }) {
  const captureDir = path.join(configDir, "fab-captures");
  const shotsDir = path.join(configDir, "fab-shots"); // full uncropped frames (mineable)
  const tmpShot = path.join(os.tmpdir(), "sc-fab-shot.png");
  let busy = false;
  let lastContext = "";
  // Context = the steady on-screen state (off/idle/watching/fabricator); reported only on change,
  // drives the overlay diamond (fabricator -> gold). Events (settling/captured/mission) are discrete
  // and fire every time without disturbing the context.
  const emitContext = (state) => { if (state !== lastContext) { lastContext = state; onStatus?.({ state }); } };
  const emitEvent = (s) => { onStatus?.(s); };
  let lastMission = "";       // last mission title sent (throttle screen-read posts)
  let lastUnresolved = "";    // last unreadable kiosk item flagged (throttle the "can't read" note)
  let lastHave = "";          // last already-on-site item flagged (throttle the "already have" note)
  let lastRenderWait = "";    // last item stuck waiting on its render (throttle the "waiting" note)
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
    // Two independent opt-ins share one screen-read: image capture and pinned-mission OCR.
    // Either one arms the loop; each read is then gated by its own flag below.
    const fab = cfg.fabCapture === true;
    const miss = cfg.missionOcr === true;
    // The Mining Assistant (refinery timers + signature scanner) also reads the screen;
    // refinery/mineable reads are routed to its tracker server-side in /api/screen-read.
    const mining = cfg.miningAssistant === true;
    if (!fab && !miss && !mining) { emitContext("off"); return; }
    if (busy) return;
    const proc = await foregroundProcess();
    if (!/^StarCitizen$/i.test(proc)) { emitContext("idle"); return; } // only ever look at SC
    busy = true;
    try {
      const have = fab ? await ensureRemoteHave() : null; // dedup set only needed for capture
      const shot = await captureScreen();
      if (!shot) return;
      fs.writeFileSync(tmpShot, shot.toPNG());
      const resp = await fetch(`http://localhost:${port}/api/screen-read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: tmpShot }),
      });
      const read = await resp.json();
      // A kiosk on screen -> "fabricator" context (gold diamond) even if image capture is off;
      // anything else while watching -> "watching".
      emitContext(read.kind === "fabricator" ? "fabricator" : "watching");
      if (read.kind !== "fabricator") { lastUnresolved = ""; lastHave = ""; lastRenderWait = ""; } // left the kiosk
      if (read.kind === "fabricator" && read.item) {
        lastUnresolved = "";
        if (!fab) { pendingItem = null; return; } // image capture disabled — ignore kiosk frames
        const item = read.item;
        // Dedup: already uploaded this session, or the site already has it. Surface it once
        // per item so the user sees it was recognized but there's nothing to capture (rather
        // than the loop looking stuck on "Reading the fabricator…").
        if (uploaded.has(item) || have.has(item)) {
          pendingItem = null;
          if (item !== lastHave) { lastHave = item; emitEvent({ state: "have", name: read.name }); }
          return;
        }
        // Settle: the kiosk's 3D render fades in over ~1-2s, so a first-glimpse capture
        // can come out half-loaded / see-through. Require the item to still be on screen
        // a poll later (this shot) before capturing, giving the render time to finish.
        if (pendingItem !== item) {
          pendingItem = item;
          emitEvent({ state: "settling", name: read.name });
          console.log(`[fab-capture] ${read.name}: waiting for render to settle`);
          return;
        }
        const c = read.crop;
        const cropped = centerTighten(shot.crop({ x: c.x, y: c.y, width: c.w, height: c.h }));
        if (!hasRender(cropped)) {
          if (item !== lastRenderWait) { lastRenderWait = item; emitEvent({ state: "render", name: read.name }); }
          console.log(`[fab-capture] ${read.name}: render not loaded yet, will retry`);
          return; // keep pendingItem so the next poll retries
        }
        lastRenderWait = "";
        // Opaque teal kiosk background -> JPEG (small, fits the ingest cap).
        const jpeg = cropped.toJPEG(82);
        fs.mkdirSync(captureDir, { recursive: true });
        fs.writeFileSync(path.join(captureDir, `${item}.jpg`), jpeg);
        // Keep the FULL uncropped frame too — it carries the materials list, stats,
        // fabrication time + recipe we may mine later. One per item.
        fs.mkdirSync(shotsDir, { recursive: true });
        fs.writeFileSync(path.join(shotsDir, `${item}.jpg`), shot.toJPEG(85));
        let uploadedOk = false;
        if (cfg.syncToken) {
          uploadedOk = await upload(item, jpeg, cfg.syncToken);
          console.log(`[fab-capture] ${uploadedOk ? "uploaded" : "saved (upload failed)"} ${read.name} (${item})`);
        } else {
          console.log(`[fab-capture] saved ${read.name} (${item}) — no sync token, not uploaded`);
        }
        emitEvent({ state: "captured", name: read.name, uploaded: uploadedOk });
      } else if (read.kind === "fabricator" && fab) {
        // In the kiosk with image capture on, but the item name didn't resolve to a known
        // blueprint (still rendering in, or an item not in our dataset) — so there's nothing
        // to tag a capture with. Surface it once per item so the user knows why no picture
        // was taken, rather than the loop failing silently.
        pendingItem = null;
        const raw = (read.nameRaw || "").trim();
        if (raw !== lastUnresolved) {
          lastUnresolved = raw;
          emitEvent({ state: "unresolved", nameRaw: raw });
          console.log(`[fab-capture] kiosk item not identified${raw ? `: "${raw}"` : ""}`);
        }
      } else if (read.kind === "mission" && miss && read.titleRaw && read.titleRaw !== lastMission) {
        // Tell the tracker which mission is pinned in-game (ground truth the log lacks).
        lastMission = read.titleRaw;
        emitEvent({ state: "mission", title: read.titleRaw });
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
