"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archverse-flatpak-xdotool-"));
const fake = path.join(tmp, "xdotool");
fs.writeFileSync(fake, `#!/bin/sh
set -eu
mode="\${MOCK_XDOTOOL_MODE:-direct}"
cmd="\${1:-}"; shift || true
case "$cmd" in
  search)
    case "$mode" in
      direct|overlay) echo 100 ;;
      gamescope_named|gamescope_bare) echo 200 ;;
      none) exit 1 ;;
    esac
    ;;
  getwindowname)
    case "$mode" in
      direct) echo "Star Citizen" ;;
      overlay) echo "Star Citizen - ArchVerse" ;;
      gamescope_named) echo "gamescope - Star Citizen" ;;
      gamescope_bare) echo "gamescope" ;;
    esac
    ;;
  getwindowclassname)
    case "$mode" in
      direct) echo "StarCitizen.exe" ;;
      overlay) echo "sc-overlay-custom-linux" ;;
      gamescope_named|gamescope_bare) echo "gamescope" ;;
    esac
    ;;
  getwindowpid)
    case "$mode" in
      direct) echo 4321 ;;
      overlay) echo 7777 ;;
      gamescope_named|gamescope_bare) echo 5555 ;;
    esac
    ;;
  getwindowgeometry)
    cat <<EOF
WINDOW=100
X=20
Y=30
WIDTH=3840
HEIGHT=2160
SCREEN=0
EOF
    ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });

process.env.PATH = `${tmp}:${process.env.PATH || ""}`;
const { FlatpakStarCitizenSessionBinder, __test } = require("../app/electron/linux/flatpak-star-citizen-session.cjs");

const silent = { log() {}, warn() {} };
function session(mode) {
  process.env.MOCK_XDOTOOL_MODE = mode;
  return new FlatpakStarCitizenSessionBinder({ logger: silent, platform: "linux" }).current();
}

try {
  const direct = session("direct");
  assert(direct, "direct Star Citizen window must bind");
  assert.equal(direct.windowId, "100");
  assert.equal(direct.windowPid, 4321);
  assert.match(direct.id, /^flatpak-x11:100:4321$/);

  const gs = session("gamescope_named");
  assert(gs, "Gamescope window that explicitly identifies Star Citizen must bind");
  assert.equal(gs.windowId, "200");
  assert.equal(gs.gamescopePid, 5555);

  assert.equal(session("gamescope_bare"), null, "generic Gamescope must be refused");
  assert.equal(session("overlay"), null, "ArchVerse's own overlay window must be refused");
  assert.equal(session("none"), null, "no matching game window means no session");

  assert(__test.candidateRank({ title: "Star Citizen", className: "StarCitizen.exe" }) > 0);
  assert(__test.candidateRank({ title: "gamescope", className: "gamescope" }) < 0);
  console.log("flatpak-session-binder: PASS");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
