"use strict";

const fs = require("node:fs");

const IS_FLATPAK = process.platform === "linux" && (
  process.env.SC_TRACKER_FLATPAK === "1"
  || !!process.env.FLATPAK_ID
  || (() => { try { return fs.existsSync("/.flatpak-info"); } catch { return false; } })()
);

module.exports = { IS_FLATPAK };
