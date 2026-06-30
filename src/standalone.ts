/**
 * Standalone launcher: starts the overlay server (in-process) and opens the blueprint
 * panel in an app-mode browser window — a desktop-app feel with no Electron.
 *
 *   npm run standalone        (dev)
 *   sc-blueprint-tracker.exe  (packaged — see npm run package)
 *
 * OBS users don't need this — they just add http://localhost:8778/missions.html as a
 * browser source. This is for playing solo on a second monitor.
 *
 * Set SC_BP_NO_WINDOW=1 to start the server without opening a window (used by smoke tests).
 */
import "./overlay-server.js"; // side-effect: starts the server on :8778
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { get } from "node:http";

const PORT = 8778;
const PAGE = `http://localhost:${PORT}/missions.html`;

function findBrowser(): string | null {
  const env = process.env;
  const candidates = [
    env.LOCALAPPDATA && `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean) as string[];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function openWindow(): void {
  if (process.env.SC_BP_NO_WINDOW) {
    console.log(`[standalone] window suppressed; open ${PAGE}`);
    return;
  }
  const browser = findBrowser();
  if (!browser) {
    console.log(`[standalone] no Chrome/Edge found — open ${PAGE} in your browser`);
    return;
  }
  const profile = `${process.env.TEMP ?? "."}\\sc-blueprint-window`;
  spawn(
    browser,
    [`--app=${PAGE}`, "--window-size=420,720", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check"],
    { detached: true, stdio: "ignore" },
  ).unref();
  console.log("[standalone] opened blueprint window");
}

// Wait for the server to accept connections, then open the window.
function waitThenOpen(tries = 40): void {
  get(`http://localhost:${PORT}/api/missions`, (r) => {
    r.resume();
    openWindow();
  }).on("error", () => {
    if (tries > 0) setTimeout(() => waitThenOpen(tries - 1), 200);
    else openWindow();
  });
}

waitThenOpen();
