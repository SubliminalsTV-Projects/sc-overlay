/**
 * NEGATIVE CONTROLS for flight `onepill` — as a script, so they cannot rot.
 *
 *   node tools/control-onepill.mjs            (needs a seeded sidecar; see below)
 *   node tools/control-onepill.mjs --port 8783
 *
 * Start the sidecar first, in another shell:
 *   npm run test:widgets:sandbox -- --port 8783 --serve
 *
 * 🔴 IT GRADES ON THE TEXT, NEVER ON AN EXIT CODE. `npm run test:widgets` has exited 0 on a run
 * that printed FAILED(1) — measured 2026-08-17 — and flight `onerow` had a control runner announce
 * "GREEN — the control proves nothing" directly beneath its own captured output reading FAIL. So
 * the verdict here comes from the FAIL lines, and a control must redden an assertion BY NAME.
 *
 * 🔴 AND IT ABORTS ON A NO-OP PATCH. This repo is CRLF; an anchor that silently matches nothing
 * leaves the source unmodified, the suite then runs on the real code and comes back green, and
 * that reads as "the assertion is a tautology" — the most expensive wrong conclusion available.
 *
 * 🔴 A CONTROL THAT CRASHES IS NOT A CONTROL. If the probe reports no assertions at all, the
 * injection broke the page rather than the behaviour, and "it went red" means nothing. That is
 * checked separately from the FAIL lines.
 *
 * ⚠️ Restores with `git checkout HEAD -- <path>` after every control, so COMMIT FIRST: anything
 * uncommitted in these two files is reverted along with the injection.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = join(ROOT, "overlay", "versefinder.html");
const SUITE = join(ROOT, "tools", "widget-dom-test.cjs");
const PROBE = join(ROOT, "tools", "__probe-onepill.cjs");
const LABEL = "verse finder: observations are PRICES, not receipts";

const argv = process.argv.slice(2);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
const PORT = String(val("--port", process.env.OVERLAY_PORT || "8783"));

/** Swap `find` for `repl` in a file, refusing to write an unchanged file. */
function patch(file, edits) {
  const before = readFileSync(file, "utf8");
  let after = before;
  for (const [find, repl] of edits) {
    if (after.indexOf(find) < 0) {
      throw new Error("ANCHOR NOT FOUND in " + file + "\n  " + find.slice(0, 90));
    }
    after = after.split(find).join(repl);
  }
  if (after === before) throw new Error("PATCH DID NOT APPLY (no-op) in " + file);
  writeFileSync(file, after);
}

function restore() {
  for (const f of ["overlay/versefinder.html", "tools/widget-dom-test.cjs"]) {
    spawnSync("git", ["checkout", "HEAD", "--", f], { cwd: ROOT });
  }
  if (existsSync(PROBE)) unlinkSync(PROBE);
}

/**
 * Build a one-suite probe by splicing a label guard into `run()` ITSELF.
 * ⛔ NEVER by filtering out `run(...)` call sites: several span two lines, so dropping the first
 * leaves an orphan `path.join(...));`, the file fails to load, and electron never exits — the
 * known 15-hour hang, arriving through the door that was meant to save time.
 */
function writeProbe() {
  const src = readFileSync(SUITE, "utf8");
  const sig = "async function run(label, script, preload, query, page) {";
  if (src.indexOf(sig) < 0) throw new Error("run() signature not found - probe cannot be built");
  const guard = sig + '\n  if (label.indexOf("' + LABEL + '") !== 0) return 0;';
  writeFileSync(PROBE, src.split(sig).join(guard));
  const chk = spawnSync(process.execPath, ["--check", PROBE], { cwd: ROOT, encoding: "utf8" });
  if (chk.status !== 0) throw new Error("probe does not parse:\n" + chk.stderr);
}

/**
 * ⚠️ SPAWN THE EXE, NOT THE .bin SHIM. `node_modules/.bin/electron.cmd` is a batch file, which
 * spawnSync cannot execute without `shell: true` — and `shell: true` concatenates argv unescaped,
 * so this repo's path ("E:\06. Dev Projects\...") splits at the first space and node reports
 * `Cannot find module 'E:.'`. Either way the probe produces no output, and a runner that only
 * looked at the FAIL lines would call that a passing control.
 */
const ELECTRON = join(ROOT, "node_modules", "electron", "dist", "electron.exe");

function runProbe() {
  if (!existsSync(ELECTRON)) {
    throw new Error("electron.exe is missing - run: node node_modules/electron/install.js");
  }
  writeProbe();
  const r = spawnSync(ELECTRON, [PROBE], {
    cwd: ROOT, encoding: "utf8", timeout: 240000, killSignal: "SIGKILL",
    env: { ...process.env, OVERLAY_PORT: PORT },
  });
  const out = (r.stdout || "") + (r.stderr || "");
  if (r.error) return out + "\nSPAWN ERROR: " + r.error.message;
  return out;
}

const CONTROLS = [
  {
    name: "C1 two pills again — the exact rendering Sub rejected",
    why: "a separate .tag chip beside the pill, which is what made [7h] [SCO] read as two boxes",
    edits: [[PAGE, [
      ['          src.className = "src";\r\n          src.textContent = cf ? " SCO" : " UEX";\r\n          a.appendChild(src);',
       '          src.className = "tag sco";\r\n          src.textContent = "SCO";'],
      ["          row.appendChild(a);\r\n        }",
       "          row.appendChild(a);\r\n          if (cf) row.appendChild(src);\r\n        }"],
    ]]],
    mustRedden: [
      "the source mark is INSIDE the age pill",
      "no .tag chip survives between the age and the price",
      "the old SCO chip class is gone from the document",
    ],
  },
  {
    name: "C2 SCO labelled, UEX not — the lone unexplained mark",
    why: "the state before this flight: a confirmed row said SCO and nothing said what the others were",
    edits: [[PAGE, [
      ['          src.textContent = cf ? " SCO" : " UEX";', '          src.textContent = cf ? " SCO" : "";'],
    ]]],
    mustRedden: [
      "and an UNCONFIRMED row is marked UEX, not left blank",
      "every drawn row names a source",
    ],
  },
  {
    name: "C3 the bright/dim SCO split, restored",
    why: "colour keyed off confirmed.setPrice again — provenance leaking back into the freshness channel",
    edits: [[PAGE, [
      ['          src.className = "src";',
       '          src.className = "src" + (cf && !cf.setPrice ? " src-dim" : "");'],
      ["  .age .src { font-size: 0.86em;",
       "  .age .src.src-dim { color: var(--cyan-dim); }\r\n  .age .src { font-size: 0.86em;"],
    ]]],
    mustRedden: ["the source word takes no colour of its own"],
  },
  {
    name: "C4 the accent-based recency ladder, restored",
    why: "--cyan/--cyan-dim back on two rungs of a semantic ladder: drake and argo invert",
    edits: [[PAGE, [
      ["  .age.fresh   { color: color-mix(in oklch, var(--green) 75%, var(--red)); }\r\n"
       + "  .age.recent  { color: color-mix(in oklch, var(--green) 50%, var(--red)); }\r\n"
       + "  .age.stale   { color: color-mix(in oklch, var(--green) 25%, var(--red)); }",
       "  .age.fresh   { color: var(--cyan); }\r\n"
       + "  .age.recent  { color: var(--cyan-dim); }\r\n"
       + "  .age.stale   { color: var(--amber); }"],
    ]]],
    mustRedden: ["fresher NEVER reads more alarming than staler"],
  },
  {
    name: "C5 a bare source word on a row with no age",
    why: "drawing the pill regardless, which prints an uncoloured mark answering a question nobody asked",
    edits: [[PAGE, [
      ['        const dated = typeof shownAt === "number" && shownAt > 0;',
       "        const dated = true;"],
    ]]],
    mustRedden: ["but it draws NO age pill"],
  },
];

let bad = 0;
console.log("negative controls for flight onepill - sidecar on :" + PORT + "\n");
for (const c of CONTROLS) {
  process.stdout.write("== " + c.name + "\n   " + c.why + "\n");
  let out = "";
  try {
    for (const [file, edits] of c.edits) patch(file, edits);
    const stat = spawnSync("git", ["diff", "--stat"], { cwd: ROOT, encoding: "utf8" }).stdout.trim();
    if (!stat) throw new Error("git diff --stat is EMPTY - nothing was injected");
    console.log("   injected: " + stat.split("\n")[0].trim());
    out = runProbe();
  } catch (e) {
    console.log("   ERROR: " + e.message + "\n");
    restore();
    bad++;
    continue;
  }
  restore();

  const fails = out.split("\n").filter((l) => l.indexOf("FAIL ") >= 0).map((l) => l.trim());
  const ran = out.indexOf("  ok ") >= 0 || fails.length > 0;
  if (!ran) {
    // A control that kills the page reports no assertions. That is a broken control, not evidence.
    console.log("   ⛔ THE SUITE NEVER REPORTED - the injection broke the page, so this proves"
      + " nothing.\n" + out.split("\n").slice(-6).join("\n") + "\n");
    bad++;
    continue;
  }
  const missing = c.mustRedden.filter((m) => !fails.some((f) => f.indexOf(m) >= 0));
  if (missing.length) {
    console.log("   ⛔ GREEN where it had to go RED. Unreddened: " + missing.join(" | "));
    console.log("      (" + fails.length + " other FAILs: "
      + fails.slice(0, 3).map((f) => f.slice(0, 70)).join(" ; ") + ")\n");
    bad++;
  } else {
    console.log("   ✅ RED, by name:");
    for (const f of fails) console.log("      " + f.slice(0, 118));
    console.log("");
  }
}

console.log(bad === 0
  ? "ALL " + CONTROLS.length + " CONTROLS BEHAVED - every assertion above can go red."
  : bad + " OF " + CONTROLS.length + " CONTROLS DID NOT BEHAVE - see above.");
process.exit(bad === 0 ? 0 : 1);
