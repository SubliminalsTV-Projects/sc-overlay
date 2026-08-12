// When a fabricator sighting becomes a prompt — `npx tsx src/fab-claim.test.ts`.
//
// The rules being pinned here are the ones that make this feature safe to ship over a running
// game: it may never tick anything on its own, it may never nag, and a prompt the player has
// stopped looking at may never be accepted. Everything else about the feature is presentation.
import { FabClaims, CLAIM_TTL_MS, MAX_PROMPTS_PER_SESSION } from "./fab-claim.js";

let failed = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${detail ? "   [" + detail + "]" : ""}`);
};

const T0 = 1_000_000;
const base = { item: "uuid-a", items: ["uuid-a"], name: "Gallant Rifle", enabled: true, owned: false };

// ── the gates ────────────────────────────────────────────────────────────────────────────
{
  const c = new FabClaims();
  check("opt-out means no prompt, ever", c.seen({ ...base, enabled: false }, T0).why === "disabled");
}
{
  const c = new FabClaims();
  check("something already owned is never offered", c.seen({ ...base, owned: true }, T0).why === "already-owned");
}
{
  const c = new FabClaims();
  const d = c.seen({ ...base, item: null }, T0);
  check("a name we can't resolve is never offered", d.why === "unresolved" && d.prompt === null,
    "we could not sync it even if they said yes");
}

// ── the happy path ───────────────────────────────────────────────────────────────────────
{
  const c = new FabClaims();
  const d = c.seen(base, T0);
  check("an unowned, resolved item prompts", d.why === "prompt" && d.prompt?.name === "Gallant Rifle");
  check("...and it expires 30s out", d.prompt?.expiresAt === T0 + CLAIM_TTL_MS);
  check("...and it is the live prompt", c.current(T0)?.item === "uuid-a");
}

// ── never restart your own timer ─────────────────────────────────────────────────────────
{
  const c = new FabClaims();
  const first = c.seen(base, T0).prompt!;
  // The OCR loop re-reads the same kiosk frame every poll. If each read replaced the prompt,
  // the countdown would reset forever and the 30s window would never actually elapse.
  const again = c.seen(base, T0 + 900);
  check("a re-read of the same kiosk frame does NOT re-prompt", again.why === "already-prompting");
  check("...and the original deadline is untouched", c.current(T0 + 900)!.expiresAt === first.expiresAt);
}

// ── expiry is real ───────────────────────────────────────────────────────────────────────
{
  const c = new FabClaims();
  c.seen(base, T0);
  check("the prompt is gone after 30s", c.current(T0 + CLAIM_TTL_MS + 1) === null);
  check("...and a late accept ticks NOTHING", c.accept(T0 + CLAIM_TTL_MS + 1) === null,
    "a stale click must not tick an item they stopped looking at");
}
{
  const c = new FabClaims();
  c.seen(base, T0);
  check("an in-window accept returns the prompt", c.accept(T0 + 5_000)?.item === "uuid-a");
  check("...and clears it, so it can't be accepted twice", c.current(T0 + 5_001) === null);
}

// ── the session budget ───────────────────────────────────────────────────────────────────
{
  const c = new FabClaims();
  let prompts = 0;
  // Walk past the kiosk repeatedly, letting each prompt lapse.
  for (let i = 0; i < 6; i++) {
    if (c.seen(base, T0 + i * (CLAIM_TTL_MS + 1_000)).why === "prompt") prompts++;
  }
  check(`one item prompts at most ${MAX_PROMPTS_PER_SESSION}x per session`, prompts === MAX_PROMPTS_PER_SESSION,
    `${prompts} prompts`);
}
{
  const c = new FabClaims();
  c.seen(base, T0);
  c.dismiss();
  // Declining spends a chance — otherwise dismissing would re-prompt on the very next poll.
  const second = c.seen(base, T0 + 1_000);
  check("dismissing spends one of the two chances", second.why === "prompt");
  check("...and the budget is then exhausted", c.seen({ ...base }, T0 + 2_000).why === "already-prompting");
}
{
  const c = new FabClaims();
  // A different item is its own budget, and may take over once the first lapses.
  c.seen(base, T0);
  const other = c.seen({ ...base, item: "uuid-b", name: "Coda Pistol" }, T0 + CLAIM_TTL_MS + 1);
  check("a different item has its own budget", other.why === "prompt" && other.prompt?.name === "Coda Pistol");
}

// ── siblings ─────────────────────────────────────────────────────────────────────────────
{
  const c = new FabClaims();
  const d = c.seen({ ...base, item: "s1", items: ["s1", "s2", "s3"], name: "Cinch Scraper Module" }, T0);
  check("same-named siblings all ride on one prompt", d.prompt?.items.length === 3,
    "the kiosk can't say which size you're looking at");
}

console.log(failed ? `\n${failed} FAILED` : "\nall passed");
process.exit(failed ? 1 : 0);
