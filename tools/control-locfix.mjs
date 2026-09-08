/**
 * Negative controls for the two location-service fixes of flight `locfix`.
 * Run with `npm run control:locfix`.
 *
 *   1. `parseShopLine` reads all five components that write `shopName[`, not two.
 *   2. `resolveOrigin`'s expired last-known may be SHOWN and may never be ATTRIBUTED.
 *
 * Each control re-injects the exact defect the assertion exists to catch, requires the suite to go
 * RED **naming that assertion**, requires the positive guards to stay GREEN, and restores the file.
 * A green control here means the assertion is a tautology, not that the code is fine.
 *
 * The runner rules, all learned the expensive way in this repo:
 *  · GRADE ON THE OUTPUT TEXT (`FAIL `), never on the exit code.
 *  · ABORT LOUDLY ON A NO-OP PATCH — a replace that matched nothing runs the suite on unmodified
 *    source and prints a perfect green, which reads as "the control proves nothing is broken".
 *  · REQUIRE THE SUITE TO HAVE REPORTED AT ALL, and to have reached its own TERMINATOR. A run that
 *    produced no assertions, or that crashed part-way, is a broken control and never a pass.
 *  · CHECK *WHICH* ASSERTION WENT RED. One that reddens a positive-first guard is a bug in the
 *    test, not evidence for it.
 *  · Restore from a copy held IN MEMORY, never from git — these are the files being protected.
 *
 * 🔑 C3 AND C4 ARE WHY THIS RUNNER EARNS ITS KEEP, and neither is a restatement of C2. C3 conflates
 * the two rungs of doubt (refuse anything `stale`) and C4 deletes the last-known fallback outright
 * — the two "obvious" ways to fix row `rm_loc-expired-place` that Sub's brief rules out. Each
 * reddens an assertion C2 leaves green, which is the argument that the three-way split is a real
 * distinction rather than decoration.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const PLAYERLOC = ["src/player-location.test.ts"];
const SIGNALS = ["src/origin-signals.test.ts"];

const CONTROLS = [
  {
    name: "C1 parseShopLine anchored on the two named components again",
    suite: PLAYERLOC,
    file: "src/player-location.ts",
    from: "  if (line.indexOf(SHOP_COMPONENT) < 0) return null;",
    to: '  { const c = line.indexOf("CEntityComponent"); if (c < 0) return null;\n'
      + '    const t = line.indexOf("UIProvider::", c); if (t < 0) return null;\n'
      + '    const b = line.slice(c + "CEntityComponent".length, t);\n'
      + '    if (b !== "Commodity" && b !== "Shop") return null; }   // CONTROL: the pre-fix rule',
    reddens: [
      "ShoppingProvider — no `UIProvider::` in its name at all — is read now",
      "a bare CEntityComponentShop line is read, [Error] severity and all",
      'MiningShopUIProvider — "MiningShop" is not "Shop" — is read now',
    ],
    // The frozen old rule lives in the SUITE, not in the code under control, so it vouches that
    // the gap is real either way. If this ever reddens, the frozen copy has been edited.
    staysGreen: [
      "the frozen old rule really does accept the two components it was written for",
      "🔴 ...and really did refuse all three of the others — the gap is not hypothetical",
      "the ITEM shop component is read too, not just the commodity one",
      "a shopId on some OTHER component is refused — the component tag is the gate",
    ],
  },
  {
    name: "C2 the expired last-known hands out an attributable id again (the shipped defect)",
    suite: SIGNALS,
    file: "src/player-origin.ts",
    from: '      attribution: { ok: false, why: "expired" },',
    to: "      attribution: { ok: true, tier: expired.tier, id: expired.id },   // CONTROL: the pre-fix behaviour",
    reddens: [
      "🔴 ...and yet NOTHING may be named from it",
      "...saying which of the two refusals it is",
    ],
    // Everything the fallback is FOR must survive the control, or the control has broken the
    // widget half instead of the attribution half and proves nothing about either.
    staysGreen: [
      "a fresh place fix hands out an attributable id, and it is the starmap's own",
      "🔑 a three-hour-old fix is STILL SHOWN as a place, with its id",
      "🔴 ...and is STILL attributable, because half a window is 'believe it less'",
      "an empty session refuses for the OTHER reason",
    ],
  },
  {
    name: "C3 `stale` conflated with expired — refuse from HALF the window (the over-strict fix)",
    suite: SIGNALS,
    file: "src/player-origin.ts",
    from: "      attribution: { ok: true, tier, id: s.id },",
    to: "      attribution: a > TRUST_MIN[tier] / 2 ? { ok: false, why: \"expired\" } : { ok: true, tier, id: s.id },   // CONTROL",
    reddens: ["🔴 ...and is STILL attributable, because half a window is 'believe it less'"],
    // The expired refusal is unaffected, which is the point: this control moves ONLY the middle
    // rung, so a suite that could not tell the rungs apart would stay green throughout.
    staysGreen: [
      "🔴 ...and yet NOTHING may be named from it",
      "a fresh place fix hands out an attributable id, and it is the starmap's own",
      "a 30-minute fix is stale — past HALF the place window",
    ],
  },
  {
    name: "C4 the last-known fallback deleted outright (the fix Sub's brief rules out)",
    suite: SIGNALS,
    file: "src/player-origin.ts",
    from: "  const expired = [...best.values()].sort((a, b) => b.at - a.at)[0];",
    to: "  const expired = undefined as unknown as OriginSignal;   // CONTROL: fallback dropped",
    reddens: [
      "🔑 a three-hour-old fix is STILL SHOWN as a place, with its id",
      "...saying which of the two refusals it is",
    ],
    // 🔑 The refusal assertion stays green here, and that asymmetry is the whole finding: dropping
    // the fallback satisfies "nothing may be named" perfectly while costing the widget its answer.
    staysGreen: [
      "🔴 ...and yet NOTHING may be named from it",
      "a fresh place fix hands out an attributable id, and it is the starmap's own",
      "🔴 ...and is STILL attributable, because half a window is 'believe it less'",
    ],
  },
];

let bad = 0;
for (const c of CONTROLS) {
  const original = readFileSync(c.file, "utf8");
  const patched = original.replace(c.from, c.to);
  if (patched === original) {
    console.log(`\n${c.name}\n  ABORT — the anchor did not match. The control would have run on`
      + ` unmodified source and printed a false green.\n  anchor: ${JSON.stringify(c.from)}`);
    bad++;
    continue;
  }
  let out = "";
  try {
    writeFileSync(c.file, patched);
    const r = spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", ...c.suite],
      { encoding: "utf8", timeout: 300_000 });
    out = (r.stdout ?? "") + (r.stderr ?? "");
  } finally {
    writeFileSync(c.file, original);
  }

  const reported = /^(ok|FAIL)/m.test(out);
  const finished = /all passed|FAILED \(\d+\)/.test(out);
  const failedLines = out.split(/\r?\n/).filter((l) => l.startsWith("FAIL"));
  const hit = c.reddens.every((a) => failedLines.some((l) => l.includes(a)));
  const vouched = c.staysGreen.every((a) => !failedLines.some((l) => l.includes(a)));

  const good = reported && finished && failedLines.length > 0 && hit && vouched;
  if (!good) bad++;
  console.log(`\n${c.name}\n  ${good ? "PASS" : "BROKEN"} — `
    + `reported=${reported} finished=${finished} failures=${failedLines.length} `
    + `reddened-the-right-one=${hit} positive-guard-survived=${vouched}`);
  for (const l of failedLines) console.log("    " + l);
}

console.log(bad ? `\nCONTROLS BROKEN (${bad})` : `\nall ${CONTROLS.length} controls behaved`);
process.exit(bad ? 1 : 0);
