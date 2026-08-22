/**
 * THE GENERATOR'S GUARDS, PROVEN ABLE TO FIRE.  `npm run test:itemshops`
 *
 * 🔴 WHY THIS IS A TEST AND NOT A COMMENT. Every guard in `build-item-shops.mts` is a REFUSAL —
 * code that runs only when something upstream has gone wrong. Refusal paths are the least-executed
 * lines in any tool, and a refusal that silently stopped working is indistinguishable from a
 * refusal that never had cause to fire: both look like a clean run, forever. The only thing that
 * tells them apart is making the bad thing happen on purpose and watching the tool object.
 *
 * 🔑 Each case is its own negative control, permanently. That is the point — a control you run once
 * by hand proves the guard worked THAT DAY; this proves it on every run.
 *
 * 🔴 AND THE PROPERTY UNDER TEST IS NOT "IT EXITS NON-ZERO" — IT IS "THE GOOD BUNDLE SURVIVED".
 * A guard that correctly complains and has already clobbered `data/item-shops.json` has failed at
 * the only job it has. Every rejection case asserts the file is byte-identical afterwards, which
 * is what the temp-stage-then-commit ordering in the generator exists to guarantee.
 *
 * Runs the REAL tool as a child process against a local fixture server, so what is exercised is
 * the actual CLI a release runs, argv parsing and all — not an importable inner function that a
 * release never calls.
 */
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const TOOL = resolve(import.meta.dirname, "build-item-shops.mts");
const REAL_BUNDLE = resolve(import.meta.dirname, "..", "data", "item-shops.json");
/** 🔴 Invoke tsx's CLI through `process.execPath` — NOT `npx tsx` under `shell: true`.
 *  With a shell, spawnSync CONCATENATES argv unescaped, and this repo lives at
 *  "E:\06. Dev Projects\..." — so the very first argument splits at the space and node reports
 *  `Cannot find module 'E:\06.'`. The whole suite then fails identically to a broken tool, which
 *  is exactly the reading the positive control at the top exists to prevent. It caught this. */
const TSX = resolve(import.meta.dirname, "..", "node_modules", "tsx", "dist", "cli.mjs");

let pass = 0;
let fail = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  if (cond) { pass++; console.log(`ok    ${name}${detail ? "  [" + detail + "]" : ""}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? "  [" + detail + "]" : ""}`); }
};

/** A minimal, VALID payload. Two terminals, three items, every quote resolvable. */
function goodPayload() {
  return {
    schema: 1,
    fetchedAt: Date.now() - 3_600_000,
    items: [
      { n: "Omnisky IX Cannon", co: "Amon & Reese Co.", c: "Guns", s: "Vehicle Weapons", z: "3", u: "aaaa", q: [{ t: 0, p: 75145, m: 1782054387 }, { t: 1, p: 78262, m: 1779474232 }] },
      { n: "Burst", co: "ArcCorp", c: "Quantum Drives", s: "Systems", z: "1", u: "bbbb", q: [{ t: 0, p: 12000, m: 1782054387 }] },
      { n: "Venture Arms", co: null, c: "Armor", s: "Armor", z: null, u: null, q: [{ t: 1, p: 592, m: 1779404055 }] },
    ],
    terminals: [
      { n: "Ship Weapons - Cousin Crow's", sys: "Stanton", body: "Crusader", place: "Orison" },
      { n: "Teach's Item Shop - Levski", sys: "Nyx", body: null, place: "Levski" },
    ],
    droppedOffline: 7,
    catalogueOnly: 99,
  };
}

/** Serve one payload, then hand back the URL. Bound to 127.0.0.1 on an EPHEMERAL port —
 *  never a fixed one, so this suite can never collide with a sidecar or another flight. */
function serve(payload: unknown): Promise<{ url: string; close: () => void }> {
  return new Promise((res) => {
    const srv: Server = createServer((_req, r) => {
      r.writeHead(200, { "Content-Type": "application/json" });
      r.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    });
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      res({ url: `http://127.0.0.1:${port}/`, close: () => srv.close() });
    });
  });
}

/** Run the tool in an ISOLATED cwd holding its own `data/item-shops.json`.
 *  The tool writes to `join(process.cwd(), "data", ...)`, so a temp cwd is what keeps this suite
 *  from ever touching the repo's real bundle.
 *
 *  🔴 ASYNC `spawn`, NEVER `spawnSync` — and this is a deadlock, not a preference. The fixture
 *  server lives in THIS process, and `spawnSync` blocks this process's event loop for the child's
 *  whole lifetime. So the child's fetch opens a connection nothing can ever accept, and both sides
 *  wait forever: the child hung until its 120s fetch timeout, every case, and the suite ran past
 *  ten minutes. The server can only answer while the parent is still turning. */
async function runTool(seed: unknown, url: string, extra: string[] = []) {
  const cwd = mkdtempSync(join(tmpdir(), "itemshops-test-"));
  mkdirSync(join(cwd, "data"));
  const bundlePath = join(cwd, "data", "item-shops.json");
  if (seed !== undefined) writeFileSync(bundlePath, JSON.stringify(seed));
  const before = existsSync(bundlePath) ? readFileSync(bundlePath, "utf8") : null;

  const { code, out } = await new Promise<{ code: number | null; out: string }>((res) => {
    const ch = spawn(process.execPath, [TSX, TOOL, "--url", url, ...extra], { cwd });
    let buf = "";
    ch.stdout.on("data", (d) => { buf += d; });
    ch.stderr.on("data", (d) => { buf += d; });
    const kill = setTimeout(() => ch.kill(), 120_000);
    ch.on("close", (c) => { clearTimeout(kill); res({ code: c, out: buf }); });
  });

  const after = existsSync(bundlePath) ? readFileSync(bundlePath, "utf8") : null;
  rmSync(cwd, { recursive: true, force: true });
  return { code, out, unchanged: before === after, after };
}

// -- 1. POSITIVE CONTROL ---------------------------------------------------------------------
// 🔑 FIRST, and it is not a formality. Every case below asserts a REFUSAL, and a tool that
// refused everything — a broken import, a bad argv parse, tsx failing to start — would satisfy
// all of them. This is what separates "the guards work" from "nothing runs".
{
  const s = await serve(goodPayload());
  const r = await runTool({ items: [], terminals: [] }, s.url);
  s.close();
  ok(r.code === 0, "a valid payload is accepted", `exit ${r.code}`);
  ok(!r.unchanged, "...and the bundle is actually written");
  const w = r.after ? JSON.parse(r.after) : null;
  ok(w?.items?.length === 3 && w?.terminals?.length === 2, "...with the payload's items and terminals",
     w ? `${w.items.length} items, ${w.terminals.length} terminals` : "no file");
  ok(w?.droppedOffline === 7 && w?.catalogueOnly === 99, "...and the two honesty counters are carried through",
     w ? `dropped=${w.droppedOffline} catalogueOnly=${w.catalogueOnly}` : "no file");
}

// -- 2. THE STORE-REJECTION GUARD ------------------------------------------------------------
// 🔴 The one that matters most. `normalise()` discards a bad table WHOLE, so a bundle that fails
// it does not degrade — it VANISHES, and the app ships saying "bundled, 0 items". Here every
// quote points at terminal index 9, which does not exist; the store drops the quotes, then drops
// the item-less items, then returns null.
// 🔑 Note the item COUNT is unchanged (3), so the shrink guard cannot be what fires. This case
// would be worthless if it tripped an earlier guard instead of the one it names.
{
  const bad = goodPayload();
  bad.items = bad.items.map((it) => ({ ...it, q: it.q.map((q) => ({ ...q, t: 9 })) }));
  const s = await serve(bad);
  const r = await runTool(goodPayload(), s.url);
  s.close();
  ok(r.code !== 0, "a table the store would reject WHOLE is refused", `exit ${r.code}`);
  ok(/rejected the table/i.test(r.out), "...and it says the store rejected it, not something vaguer");
  ok(r.unchanged, "...and the good bundle is untouched on disk");
}

// -- 3. THE SHRINK GUARD ---------------------------------------------------------------------
// An upstream that is UP but partly broken serves a valid, well-formed, SMALLER table. It passes
// every structural check there is, because it is structurally perfect. Size is the only tell.
{
  const small = goodPayload();
  small.items = small.items.slice(0, 1); // 3 -> 1, a 67% drop
  const s = await serve(small);
  const r = await runTool(goodPayload(), s.url);
  s.close();
  ok(r.code !== 0, "a table that shrank far past the threshold is refused", `exit ${r.code}`);
  ok(/smaller/i.test(r.out), "...and it names the shrink");
  ok(r.unchanged, "...and the good bundle is untouched on disk");
}

// -- 4. --force IS AN ESCAPE HATCH, NOT A NO-OP ----------------------------------------------
// The shrink guard has to be overridable — a real UEX purge is indistinguishable from a broken
// poll from here, and a guard with no override becomes a guard people delete.
{
  const small = goodPayload();
  small.items = small.items.slice(0, 1);
  const s = await serve(small);
  const r = await runTool(goodPayload(), s.url, ["--force"]);
  s.close();
  ok(r.code === 0, "--force writes the shrunken table anyway", `exit ${r.code}`);
  ok(!r.unchanged, "...and the bundle really changed");
}

// -- 5. AN EMPTY 200 IS NOT A SUCCESS --------------------------------------------------------
// The site serves a stale copy through an upstream failure by design, so a 200 is NOT evidence of
// content. A genuinely empty one would replace a good bundle with nothing while looking healthy.
{
  const s = await serve({ schema: 1, fetchedAt: Date.now(), items: [], terminals: [] });
  const r = await runTool(goodPayload(), s.url);
  s.close();
  ok(r.code !== 0, "an empty table behind a 200 is refused", `exit ${r.code}`);
  ok(r.unchanged, "...and the good bundle is untouched on disk");
}

// -- 6. A NON-200, AND A BODY THAT ISN'T JSON ------------------------------------------------
{
  const srv = createServer((_q, r) => { r.writeHead(503); r.end("upstream down"); });
  await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
  const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}/`;
  const r = await runTool(goodPayload(), url);
  srv.close();
  ok(r.code !== 0, "a 503 is refused", `exit ${r.code}`);
  ok(r.unchanged, "...and the good bundle is untouched on disk");
}
{
  const s = await serve("<html>not json</html>");
  const r = await runTool(goodPayload(), s.url);
  s.close();
  ok(r.code !== 0, "a non-JSON body is refused", `exit ${r.code}`);
  ok(r.unchanged, "...and the good bundle is untouched on disk");
}

// -- 7. THE REAL SHIPPED BUNDLE STILL LOADS --------------------------------------------------
// 🔑 Not a tautology: this reads the file that is actually committed and checks it against the
// rule that decides whether the app has offline data at all. If someone hand-edits the bundle, or
// a merge mangles it, this is what says so. Asserted on the FILE, not on anything this suite made.
{
  let bundle: { items?: unknown[]; terminals?: unknown[]; fetchedAt?: number } | null = null;
  try { bundle = JSON.parse(readFileSync(REAL_BUNDLE, "utf8")); } catch { /* reported below */ }
  ok(!!bundle, "the committed data/item-shops.json parses");
  ok((bundle?.items?.length ?? 0) > 1000, "...and carries a real catalogue",
     `${bundle?.items?.length ?? 0} items`);
  ok((bundle?.terminals?.length ?? 0) > 100, "...and a real terminal table",
     `${bundle?.terminals?.length ?? 0} terminals`);
  ok(typeof bundle?.fetchedAt === "number", "...and states when it was polled, so its age is knowable");
}

console.log(`\n${fail ? `FAILED (${fail})` : "all passed"}  ${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
