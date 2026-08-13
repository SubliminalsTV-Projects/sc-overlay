"use strict";

// Flatpak deliberately provides a private /proc, so the native ArchVerse session binder cannot
// inspect host process ancestry from inside the sandbox. Do not punch a host-command escape into
// the sandbox just to recover /proc. Instead, bind the Flatpak build to the exact X11/XWayland
// game window exposed through the x11 socket. The X11 window id becomes the launch identity and
// is revalidated before every sensitive action/capture cycle.

const { execFileSync } = require("node:child_process");

function numericPid(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function runXdotool(args, timeout = 1200) {
  try {
    return String(execFileSync("xdotool", args, {
      encoding: "utf8",
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
    })).trim();
  } catch {
    return "";
  }
}

function windowDetails(id) {
  const windowId = String(id || "").trim();
  if (!/^\d+$/.test(windowId)) return null;
  const title = runXdotool(["getwindowname", windowId]);
  const className = runXdotool(["getwindowclassname", windowId]);
  const pidText = runXdotool(["getwindowpid", windowId]);
  const pid = /^\d+$/.test(pidText) ? Number(pidText) : null;
  const geometry = runXdotool(["getwindowgeometry", "--shell", windowId]);
  const num = (key) => Number((geometry.match(new RegExp(`^${key}=(-?\\d+)$`, "m")) || [])[1]);
  const x = num("X"), y = num("Y"), width = num("WIDTH"), height = num("HEIGHT");
  return {
    id: windowId,
    title,
    className,
    pid,
    rect: [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
      ? { x, y, width, height }
      : null,
  };
}

function detailsBlob(details) {
  return [details?.title, details?.className].filter(Boolean).join(" ");
}

function isOverlay(details) {
  return /sc-overlay-custom-linux|sc-blueprint-tracker|\bSC Overlay\b|ArchVerse/i.test(detailsBlob(details));
}

function isLauncher(details) {
  return /RSI Launcher|StarCitizen_Launcher/i.test(detailsBlob(details));
}

function isDirectGame(details) {
  const blob = detailsBlob(details);
  return /Star\s*Citizen|StarCitizen(?:\.exe)?/i.test(blob) && !isLauncher(details);
}

function isGamescope(details) {
  return /gamescope(?:-wl)?/i.test(detailsBlob(details));
}

function isGamescopeGame(details) {
  const blob = detailsBlob(details);
  return isGamescope(details) && /Star\s*Citizen|StarCitizen/i.test(blob);
}

function searchIds() {
  const ids = new Set();
  const searches = [
    ["search", "--onlyvisible", "--name", "Star Citizen"],
    ["search", "--onlyvisible", "--class", "StarCitizen"],
    ["search", "--onlyvisible", "--classname", "StarCitizen"],
    ["search", "--onlyvisible", "--name", "StarCitizen"],
    ["search", "--onlyvisible", "--class", "gamescope"],
    ["search", "--onlyvisible", "--name", "gamescope"],
  ];
  for (const args of searches) {
    const out = runXdotool(args, 1500);
    for (const id of out.split(/\s+/).filter((value) => /^\d+$/.test(value))) ids.add(id);
  }
  return [...ids];
}

function candidateRank(details) {
  if (!details || isOverlay(details) || isLauncher(details)) return -1;
  if (isGamescopeGame(details)) return 300;
  if (isDirectGame(details) && !isGamescope(details)) return 250;
  // A bare "gamescope" window is intentionally NOT trusted. Capturing a generic Gamescope
  // surface merely because one exists would regress Alpha 22's privacy/session gate. If a
  // compositor does not propagate Star Citizen into the window title/class, the Flatpak doctor
  // reports that condition instead of silently capturing some other game/window.
  return -1;
}

class FlatpakStarCitizenSessionBinder {
  constructor({ logger = console, platform = process.platform } = {}) {
    this.logger = logger;
    this.platform = platform;
    this.bound = null;
    this.warnedBareGamescope = false;
    this.windowCache = new Map();
  }

  details(id) {
    const details = windowDetails(id);
    if (details) this.windowCache.set(String(id), details);
    return details;
  }

  discover() {
    if (this.platform !== "linux") return null;
    const candidates = [];
    let bareGamescope = false;
    for (const id of searchIds()) {
      const details = this.details(id);
      if (!details) continue;
      const rank = candidateRank(details);
      if (rank >= 0) candidates.push({ details, rank });
      else if (isGamescope(details) && !isOverlay(details)) bareGamescope = true;
    }
    candidates.sort((a, b) => {
      if (a.rank !== b.rank) return b.rank - a.rank;
      const aa = (a.details.rect?.width || 0) * (a.details.rect?.height || 0);
      const ba = (b.details.rect?.width || 0) * (b.details.rect?.height || 0);
      return ba - aa;
    });
    const chosen = candidates[0]?.details || null;
    if (!chosen) {
      if (bareGamescope && !this.warnedBareGamescope) {
        this.warnedBareGamescope = true;
        this.logger?.warn?.("[sc-session-flatpak] Gamescope is visible but its X11 title/class does not identify Star Citizen; refusing an unsafe generic bind");
      }
      return null;
    }
    this.warnedBareGamescope = false;
    const gamescope = isGamescope(chosen);
    return {
      id: `flatpak-x11:${chosen.id}:${chosen.pid || 0}`,
      flatpakWindowBound: true,
      windowId: chosen.id,
      windowPid: chosen.pid || null,
      windowTitle: chosen.title || "",
      windowClass: chosen.className || "",
      windowRect: chosen.rect || null,
      gamePid: chosen.pid || null,
      gameStartTicks: 0,
      launcherPid: null,
      reaperPid: null,
      gamescopePid: gamescope ? (chosen.pid || null) : null,
      gamescopeStartTicks: 0,
      gameCommand: chosen.title || chosen.className || "Star Citizen",
      gamescopeCommand: gamescope ? (chosen.title || chosen.className || "gamescope") : "",
      discoveredAt: Date.now(),
    };
  }

  validate(session = this.bound) {
    if (!session || this.platform !== "linux" || !/^\d+$/.test(String(session.windowId || ""))) return false;
    const details = this.details(session.windowId);
    if (!details || candidateRank(details) < 0) return false;
    if (session.windowPid && details.pid && Number(session.windowPid) !== Number(details.pid)) return false;
    return true;
  }

  current() {
    if (this.platform !== "linux") return null;
    if (this.validate(this.bound)) return this.bound;
    if (this.bound) {
      this.logger?.log?.(`[sc-session-flatpak] released Star Citizen X11 window ${this.bound.windowId}`);
      this.bound = null;
    }
    const found = this.discover();
    if (found) {
      this.bound = found;
      this.logger?.log?.(`[sc-session-flatpak] bound Star Citizen to X11 window ${found.windowId}${found.windowPid ? ` (PID property ${found.windowPid})` : ""}`);
    }
    return this.bound;
  }

  processRunning() {
    return !!this.current();
  }

  readProcess(pid) {
    const n = numericPid(pid);
    const session = this.current();
    if (!n || !session || Number(session.windowPid) !== n) return null;
    return {
      pid: n,
      ppid: null,
      comm: String(session.windowClass || (session.gamescopePid ? "gamescope" : "StarCitizen")),
      cmdline: String(session.windowTitle || ""),
      args: [],
      startTicks: 0,
    };
  }

  listPids() {
    const session = this.current();
    return session?.windowPid ? [Number(session.windowPid)] : [];
  }

  belongsToSession(pid, session = this.current()) {
    const n = numericPid(pid);
    if (!n || !session) return false;
    return Number(session.windowPid || 0) === n;
  }

  ancestors() {
    return [];
  }

  summary(session = this.current()) {
    if (!session) return null;
    return {
      id: session.id,
      gamePid: session.gamePid,
      launcherPid: null,
      reaperPid: null,
      gamescopePid: session.gamescopePid,
      windowId: session.windowId,
      flatpakWindowBound: true,
    };
  }
}

module.exports = {
  FlatpakStarCitizenSessionBinder,
  __test: {
    candidateRank,
    detailsBlob,
    isDirectGame,
    isGamescope,
    isGamescopeGame,
  },
};
