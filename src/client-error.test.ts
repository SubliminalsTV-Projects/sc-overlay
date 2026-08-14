// The client-error intake and the diagnostics log tail, end to end against a real sidecar.
//
//   npx tsx src/client-error.test.ts
//
// WHY THIS EXISTS. A canvas JS error used to be recorded NOWHERE — the shell's and renderer's
// consoles do not exist in a packaged build, so the whole class of "it just looks frozen" bugs
// (the mission-report repaint bug, the tray-menu crash) left no trace a user could send. The
// canvas now forwards errors to POST /api/client-error, the sidecar remembers them, and Copy
// diagnostics carries them plus the tail of sidecar.log. Asserted against the real server
// because the interesting failures are in the plumbing, not the pure functions: the route being
// missing, the buffer growing without bound, or the log tail leaking a token.

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${name}${extra ? "  — " + extra : ""}`);
};

const PORT = 8792;                       // not 8778: that is the user's real app
const BASE = `http://localhost:${PORT}`;
const home = mkdtempSync(join(tmpdir(), "client-error-"));
const userDir = join(home, "sc-blueprint-tracker");
const SECRET = "sekrit-sync-token-abc123";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let child: ChildProcess | null = null;
async function boot(): Promise<void> {
  // A config with a sync token, and a previous "session's" log that MENTIONS the token —
  // the tail must carry the line and must not carry the secret.
  mkdirSync(userDir, { recursive: true });
  writeFileSync(join(userDir, "config.json"), JSON.stringify({ syncToken: SECRET }));
  writeFileSync(join(userDir, "sidecar.log"),
    ["[fake] line one", `[fake] pushing with token ${SECRET}`, "[fake] line three"].join("\n") + "\n");
  child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/overlay-server.ts"], {
    env: { ...process.env, APPDATA: home, HOME: home, PORT: String(PORT), SC_NO_SYNC: "1" },
    stdio: "ignore",
    windowsHide: true,   // every child process here gets this — see the rule in SKILL.md
  });
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${BASE}/api/instance`, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("sidecar never came up on " + PORT);
}

const post = (body: unknown) =>
  fetch(`${BASE}/api/client-error`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  });

async function main(): Promise<void> {
  await boot();

  // A real error is accepted and shows up in diagnostics.
  const r1 = await post({ source: "canvas", msg: "boom at render()", stack: "Error: boom\n  at render" });
  check("an error report is accepted", r1.ok, `status ${r1.status}`);
  let d: any = await (await fetch(`${BASE}/api/diagnostics`)).json();
  const errs: any[] = d.recentClientErrors ?? [];
  check("...and appears in diagnostics", errs.some((e) => String(e.msg).includes("boom at render()")),
    JSON.stringify(errs).slice(0, 120));
  // errs.length is part of the assertion — [].every() is vacuously true, and a vacuous pass
  // here would hide the route not storing anything at all.
  check("...stamped with a time and a source", errs.length > 0 && errs.every((e) => e.at && e.from));

  // Garbage does not crash the intake or the server.
  const r2 = await post("not json at all{{{");
  check("garbage body is refused politely", r2.status >= 400 || r2.ok, `status ${r2.status}`);
  const alive = await fetch(`${BASE}/api/instance`, { signal: AbortSignal.timeout(2000) });
  check("...and the server is still up", alive.ok);

  // A flood cannot grow the buffer without bound, and gets rate limited.
  let refused = 0;
  for (let i = 0; i < 60; i++) {
    const r = await post({ source: "canvas", msg: "flood " + i });
    if (r.status === 429) refused++;
  }
  d = await (await fetch(`${BASE}/api/diagnostics`)).json();
  check("the buffer is capped", (d.recentClientErrors ?? []).length <= 20,
    String((d.recentClientErrors ?? []).length));
  check("a flood is rate limited", refused > 0, `${refused} of 60 refused`);

  // The log tail rides in diagnostics, and the token does not ride with it.
  const tail: string[] = d.logTail?.lines ?? [];
  check("diagnostics carries the sidecar.log tail", tail.some((l) => l.includes("line one")),
    JSON.stringify(tail).slice(0, 120));
  check("...with the sync token REDACTED", tail.every((l) => !l.includes(SECRET)) &&
    tail.some((l) => l.includes("[redacted]")));
}

main()
  .catch((e) => { failures++; console.log("FAIL  harness: " + String((e as Error)?.message || e)); })
  .finally(() => {
    try { child?.kill(); } catch { /* already gone */ }
    setTimeout(() => {
      try { rmSync(home, { recursive: true, force: true }); } catch { /* windows lock */ }
      console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
      process.exit(failures ? 1 : 0);
    }, 300);
  });
