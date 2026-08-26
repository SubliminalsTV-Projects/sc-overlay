/**
 * RUN THE WIDGET SUITE AGAINST A SANDBOXED SIDECAR THAT CARRIES ITS OWN PRICE DATA.
 *
 *   npm run test:widgets:sandbox
 *   npm run test:widgets:sandbox -- --port 8791 --reset --keep
 *   npm run test:widgets:sandbox -- --serve        seed and hold the sidecar, run no suite
 *
 * `--serve` is what you want while iterating on a widget or running a negative control: it gives
 * you a seeded sidecar to point `OVERLAY_PORT=<n> npm run test:widgets` at, or a probe file, or a
 * browser. A control on anything under `src/` needs the sidecar RESTARTED to be seen at all - tsx
 * does not reload - so re-run this after every such edit.
 *
 * 🔴 WHY THIS EXISTS: FIVE VERSE FINDER ASSERTIONS USED TO PASS OR FAIL ON WHOSE PROFILE THE
 * SIDECAR HAPPENED TO BE POINTED AT.
 *
 * The commodity block of `verse finder: ships, commodities, and which kind of blank` searches for
 * "laranite" and asserts the widget names terminals, states stock in SCU, and points at the Trade
 * widget for selling. Those rows come from `TradePriceStore`, which resolves live -> cache ->
 * bundled:
 *
 *   live     https://subliminal.gg/api/sc/commodity-prices
 *   cache    %APPDATA%/sc-blueprint-tracker/trade-prices.json
 *   bundled  data/commodities.json
 *
 * The bundled snapshot carries NO timestamps, and `verse-commodities.ts` drops any quote with no
 * `asOf` on purpose - an age colour beside a quote whose age is unknowable reads as "fresh". So on
 * the bundled floor every commodity quote is discarded and the Verse Finder answers "laranite"
 * with the same blank it gives a typo. Measured 2026-08-24, that floor is where everybody lands:
 * the live endpoint answers **404** (its item-price sibling answers 200), so only a profile
 * holding a cache written back when it worked - Sub's does - has dated commodity prices at all.
 *
 * A green run therefore meant "somebody's %APPDATA% happens to hold a 657 KB file", which is not
 * a gate. This script removes the question: it seeds a throwaway profile from a committed fixture
 * and runs the suite against a sidecar with no network of its own.
 *
 * -- WHAT IT DOES ----------------------------------------------------------------------------
 *
 *   1. Owns `.test-profile/` in the repo (gitignored). `--reset` wipes it first.
 *   2. Writes `tools/fixtures/trade-prices.json` into it as a real cache file, stamping each
 *      quote's `asOfDaysAgo` into an absolute `asOf` against the clock it runs on.
 *   3. Starts the sidecar there with SC_NO_SYNC=1 and BOTH price endpoints switched off
 *      (SC_TRADE_URL="" and SC_VERSE_URL=""), so the run touches no network and the item half
 *      reads the committed `data/item-shops.json` rather than whatever the site is serving today.
 *   4. Runs the same three steps `npm run test:widgets` runs, against that port.
 *   5. Kills the sidecar BY THE PID `/api/instance` REPORTS - never by name, never by a
 *      command-line match. That rule exists because a broad filter once took Sub's own app down.
 *
 * 🔑 THE AGES ARE RELATIVE ON PURPOSE. A fixture with absolute timestamps in it starts describing
 * a quote that is one day old and ends up describing one that is three years old, silently moving
 * every row into the oldest age band. Storing the age and stamping it at seed time means the
 * fixture keeps saying what it was written to say for as long as it exists.
 *
 * ⚠️ THE FIXTURE IS NOT SHIPPED. `tools/build-server.mjs` copies `overlay/` and `data/`; nothing
 * under `tools/fixtures/` reaches a build, and the sandbox profile is not the app's profile.
 *
 * -- REGENERATING THE FIXTURE ----------------------------------------------------------------
 *
 * It is a trim of a real `trade-prices.json`: every commodity the table knows (122), capped at
 * four quotes each so the name space stays whole while the file stays small, with Laranite kept
 * in full because it is the suite's subject. 473 quotes / 120 KB against the 657 KB it came from.
 * To rebuild it after a patch moves the economy, take a fresh cache file, keep the same fields,
 * and replace each `asOf` with `asOfDaysAgo = (fetchedAt/1000 - asOf) / 86400`.
 *
 * 🔑 KEEP EVERY COMMODITY NAME. Trimming to the handful the assertions mention would make "a
 * commodity is findable from this box" a claim about a table with nothing in it to compete, which
 * is the vacuous version of the same test.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PROFILE = join(ROOT, ".test-profile");
const STATE = join(PROFILE, "sc-blueprint-tracker");
const FIXTURE = join(ROOT, "tools", "fixtures", "trade-prices.json");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = String(value("--port", process.env.OVERLAY_PORT || "8779"));
// 🔴 8778 is the live dev app's port and `reclaimStalePort()` KILLS whatever our-shaped sidecar it
// finds there. A sandbox that can take Sub's running app down is not a sandbox.
if (PORT === "8778") {
  console.error("refusing to use port 8778 - that is the live dev app's port. Pass --port <other>.");
  process.exit(2);
}

if (flag("--reset") && existsSync(PROFILE)) {
  rmSync(PROFILE, { recursive: true, force: true });
  console.log("wiped the sandbox profile");
}

/** Turn the fixture into the cache file `TradePriceStore.readCache()` expects. */
function seed() {
  const fx = JSON.parse(readFileSync(FIXTURE, "utf8"));
  if (!Array.isArray(fx.quotes) || !fx.quotes.length) throw new Error("fixture has no quotes");
  const nowSec = Math.floor(Date.now() / 1000);
  const quotes = fx.quotes.map((q) => {
    const { asOfDaysAgo, ...rest } = q;
    return { ...rest, asOf: nowSec - Math.round(Number(asOfDaysAgo || 0) * 86400) };
  });
  // Every quote must be dated or `verse-commodities.ts` drops it and this whole exercise buys
  // nothing. Say so here rather than three minutes later as five failed assertions.
  const undated = quotes.filter((q) => !(typeof q.asOf === "number" && q.asOf > 0)).length;
  if (undated) throw new Error(`${undated} fixture quotes came out undated`);
  mkdirSync(STATE, { recursive: true });
  writeFileSync(join(STATE, "trade-prices.json"),
    JSON.stringify({ quotes, fetchedAt: Date.now(), droppedOffline: 0 }));
  console.log(`seeded  : ${quotes.length} commodity quotes from tools/fixtures/trade-prices.json`);
}

seed();
console.log(`profile : ${PROFILE}`);
console.log(`port    : ${PORT}`);
console.log("network : OFF (SC_TRADE_URL, SC_VERSE_URL, SC_POOL_URL empty; SC_EMOTE_PROXY=0), sync OFF\n");

const env = {
  ...process.env,
  APPDATA: PROFILE,
  HOME: PROFILE,
  PORT,
  SC_NO_SYNC: "1",
  // Empty string is the documented "deliberately offline" setting for both stores, and it is what
  // makes the run repeatable: the tables come from the repo, not from what the site serves today.
  SC_TRADE_URL: "",
  SC_VERSE_URL: "",
  // 🔴 THE COMMUNITY POOL IS OFF BY DEFAULT FOR THE SAME REASON THE OTHER TWO ARE. It is a LIVE
  // endpoint whose contents change whenever anybody shops, so a suite that fetched it would pass
  // or fail on what strangers did this afternoon — the worst kind of flake, because it looks like
  // a regression in the widget. Set SC_POOL_URL yourself (a file server, a site dev server) when
  // you want to exercise the live path deliberately.
  SC_POOL_URL: process.env.SC_POOL_URL ?? "",
  // 🔴 THE EMOTE PROVIDERS ARE OFF FOR THE SAME REASON, and this one is not hypothetical: on
  // 2026-08-25 FrankerFaceZ's origin went down and the Twitch Chat widget's emote fetch made the
  // whole suite intermittently red — green once and red twice on the same unmodified tree. The
  // widget reaches them through the sidecar now, so switching the sidecar off is all it takes for
  // a run to be genuinely independent of whether 7TV, BTTV, FFZ and ivr.fi are up this afternoon.
  SC_EMOTE_PROXY: process.env.SC_EMOTE_PROXY ?? "0",
};

const tsx = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
// 🔑 `process.execPath` + the cli entry rather than a shell: this repo lives under a path with a
// space in it, and `shell: true` concatenates argv unescaped and splits on it.
const sidecar = spawn(process.execPath, [tsx, join("src", "overlay-server.ts")],
  { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
const sidecarLog = [];
sidecar.stdout.on("data", (d) => sidecarLog.push(String(d)));
sidecar.stderr.on("data", (d) => sidecarLog.push(String(d)));

let sidecarPid = null;

async function waitForSidecar() {
  for (let i = 0; i < 120; i++) {
    if (sidecar.exitCode !== null) break;
    try {
      const r = await fetch(`http://localhost:${PORT}/api/instance`);
      if (r.ok) {
        const j = await r.json();
        sidecarPid = typeof j.pid === "number" ? j.pid : null;
        return true;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function stopSidecar() {
  // 🔴 BY THE PID `/api/instance` REPORTED, never by name and never by a command-line match.
  if (sidecarPid) { try { process.kill(sidecarPid); } catch { /* already gone */ } }
  try { sidecar.kill(); } catch { /* already gone */ }
}

function step(cmd, args) {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, OVERLAY_PORT: PORT }, stdio: "inherit" });
    c.on("exit", (code) => resolve(code ?? 1));
  });
}

const up = await waitForSidecar();
if (!up) {
  console.error(`sidecar never answered on :${PORT}`);
  console.error(sidecarLog.join("").slice(-2000));
  stopSidecar();
  process.exit(1);
}

if (flag("--serve")) {
  console.log(`sidecar up on :${PORT} (pid ${sidecarPid}). Ctrl-C to stop.`);
  console.log(`  OVERLAY_PORT=${PORT} npm run test:widgets`);
  process.on("SIGINT", () => { stopSidecar(); process.exit(0); });
  await new Promise(() => {}); // hold
}

const electron = join(ROOT, "node_modules", "electron", "dist", "electron.exe");
// The same three steps `npm run test:widgets` runs, in the same order. The two checks are cheap and
// they are the only thing standing between a stray backtick and a run that hangs for hours.
let code = await step(process.execPath, [join("tools", "check-suite-literals.cjs")]);
if (code === 0) code = await step(process.execPath, ["--check", join("tools", "widget-dom-test.cjs")]);
// `--pairs` is forwarded so the RELEASE run can be made here too — the release recipe reaches for
// this script whenever another session is holding the default port, and a release check that
// silently could not opt into the pair merges would be the exact false green they exist to prevent.
if (code === 0) code = await step(electron, [join("tools", "widget-dom-test.cjs"), ...(flag("--pairs") ? ["--pairs"] : [])]);

if (flag("--keep")) {
  console.log(`\nsidecar left running on :${PORT} (pid ${sidecarPid}) - --keep was passed`);
} else {
  stopSidecar();
}
process.exit(code);
