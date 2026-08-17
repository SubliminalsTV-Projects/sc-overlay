# Audit plan: error handling & redundancy pass (SC Overlay)

**For the executing session (Opus 5):** this file is your brief. It was written 2026-08-14 by a
planning session after surveying the tree at `main` @ `2238c3f`. Keep this file and your report
OUT of any commit (stage by path — never `git add -A`; that rule has real history here).

## Why this exists

A livestream viewer told Sub: *"does your app contain error handling or redundancy? this is
usually how I can tell AI code from human coding."* The heuristic as stated is half-wrong —
good human code handles errors too — but the underlying tells are real, and this repo's own
history proves the silent-failure version of them is genuinely dangerous:

- A swallowed `setPointerCapture` failure shipped a stuck drag lock that ate every click and
  keystroke (fixed in 0.1.43-pending work).
- An optional-chaining bridge call (`__bindingHost?.(…)` vs the published `__bindingChartHost`)
  meant a feature had **never worked** and nothing ever said so.
- A `const el = wEl(w); if (!el) return;` guard silently discarded pushed widget state — the app
  started with no widgets for weeks.
- The OCR health check self-tested the wrong engine, so RapidOCR being dead in every packaged
  build was invisible until a tester decompiled the asar.

**So the goal is NOT "strip error handling."** The goal is:

> Every failure path is deliberate — it handles the error with a stated reason, surfaces it
> loudly, or doesn't exist. Every duplication is justified or gone.

That standard is what distinguishes human code, and it's what Sub can honestly say on stream.

## Before you touch anything

1. **Load the `dev-bp-tracker` skill and read its SKILL.md in full.** It is the accumulated
   scar tissue of this repo. Non-negotiable rules that apply directly to this task:
   - Stage by path, never `git add -A`. Other sessions may hold uncommitted work in shared
     files — check `git status --short` and the mtime of any dirty file before editing it.
     At planning time `overlay/missions.html` was dirty from another session; re-check.
   - Use the Edit tool with exact strings. Never a scripted/regex edit on `missions.html`
     (~3,000 lines; a greedy regex once silently deleted 850 of them).
   - Never `git stash` in this repo.
   - A backtick or backslash-escape inside a widget-test suite body kills the whole run while
     exiting 0. Run `node --check tools/widget-dom-test.cjs` before every suite run.
   - `test:widgets` defaults to :8778 which is usually the INSTALLED app. Always run
     `OVERLAY_PORT=<n> npm run test:widgets` against a sidecar started from the repo
     (`APPDATA=<throwaway> PORT=8779 SC_NO_SYNC=1 npx tsx src/overlay-server.ts`).
   - Anything that must be readable (by a user or by you) logs via the SIDECAR
     (→ `sidecar.log`). `console.log` in `electron/` goes nowhere.
   - New assertions must be negative-controlled: re-inject the regression, watch it fail,
     revert. An assertion you have never seen fail is not evidence.
2. **Do not entangle with the 0.1.43 release gate.** The `payoutCalculated` / 2,045-modelled-
   payouts question (`316b353`) is Sub's call and explicitly out of scope here — even though
   "a flag nothing reads" looks like exactly what this audit hunts. Report it as already-known;
   don't wire it, don't revert it.
3. **Scope:** shipped code only — `src/` (54 files), `electron/` (7), `overlay/*.html` (inline
   JS). `tools/` and `*.test.ts` only where a change forces a test update. Skip `data/`,
   generated files, and the `linux` branch.
4. **Sub's coding guidelines govern every edit:** surgical changes, minimum code, no
   speculative abstraction, match existing style. Every changed line must trace to this audit.

## Baseline census (planning session, 2026-08-14, `main` @ `2238c3f`)

Verify these numbers first — if they've moved a lot, the tree changed and you should re-survey.

| Metric | Count | Command |
|---|---|---|
| Total `catch` sites (src+electron+overlay) | 433 | `grep -rEo "catch" src electron overlay --include='*.ts' --include='*.cjs' --include='*.html' \| wc -l` |
| Empty `catch {}` (most carry a why-comment) | ~20 | `grep -rEn "catch(\s*\([a-zA-Z_]*\))?\s*\{\s*(/\*.*\*/)?\s*\}" src electron overlay …` |
| `.catch(() => {})` silent swallows | 11 | `grep -rEn "\.catch\(\(\)\s*=>\s*\{?\s*\}?\)" …` |
| catch-to-default (`catch(() => null/[]/false)`) | 14 | `grep -rEn "catch.*=>.*(null\|\[\]\|\{\}\|undefined\|false)\)" …` |
| Optional-chaining CALL sites `?.()` | 152 | `grep -rEo "\?\.\(" overlay src …` |
| `if (!x) return;` silent guards, worst file | 40 in `overlay/missions.html` | `grep -rEc "if \(![a-zA-Z_.]+\) return;" …` |
| try/catch density leaders | `electron/main.cjs` 61 · `src/overlay-server.ts` 42 · `electron/capture.cjs` 19 | `grep -rc "try {" src electron` |
| Duplicated `esc` helper | 3 pages (`chat`, `config`, `payout-scan`) + `setup.html` variant | `grep -rl "const esc =" overlay` |
| Shared `<script src>` across widget pages | **0** — all page JS is inline by design | `grep -rhEo '<script src="[^"]+"' overlay` |

Notable: most empty catches already carry a why-comment (`/* already closed */`,
`/* stays false */`) — that's the house style and it is exactly right. The audit's job is to
bring the undocumented minority up to that standard, not to invent a new one.

## Phase 1 — Catch-site audit (error handling)

**Rubric.** Every catch site resolves to exactly one of:

- **KEEP** — swallowing is correct AND the comment says why. Most sites already pass. Do not
  touch a passing site; do not reword existing comments.
- **DOCUMENT** — swallowing is correct but the reason is unstated. Add the one-line
  why-comment in house style (`catch { /* reason */ }`). No behavior change.
- **LOUDEN** — the failure matters and is currently invisible. Route it to the sidecar log
  (once, not per-tick — a hot loop that logs every failure floods `sidecar.log`; use the
  existing log-once / counter patterns in `overlay-server.ts` where a loop is involved).
- **PROPAGATE** — the catch exists only to re-wrap or was cargo-culted; let it throw. Rare
  here; require a test proving the caller handles it.
- **DELETE** — the guarded operation cannot fail (impossible-scenario handling). Require
  proof, not vibes: cite why it can't throw. When in doubt, DOCUMENT instead.

**Order of attack** (highest silent-failure risk first):

1. The 11 `.catch(() => {})` and the undocumented subset of empty catches.
2. The 14 catch-to-default sites — for each, ask: does the default MASK a state someone needs
   to see? (House precedent: the community-data fetch caches failure and shows stale data
   rather than pretending; `dropStaleLocation()`'s "can't tell" branch had to fail toward
   clearing, not keeping. Decide which way ignorance should fail and write it down.)
3. `electron/main.cjs` (61 try blocks) and `electron/capture.cjs` (19) — these run where
   stdout goes nowhere, so a swallow there is the most invisible in the app. Anything worth
   logging must travel to the sidecar (send along an existing request; don't add a channel).
4. `src/overlay-server.ts` (42) — high count but mostly documented; sweep for the minority.

**Also in this phase — health checks that test the wrong thing.** The RapidOCR lesson: a
"working" signal must exercise the thing it vouches for. Inventory every self-test /
health / verify path (`ocr-selftest`, `waitForServer`/instance nonce, sync token verify via
`/api/sc/entitlement`, watcher liveness) and confirm each one fails when its subject fails.
Report only, unless one is provably vouching for the wrong subject.

**Verify:** `npx tsc --noEmit` clean · relevant `npm run test:*` suites green ·
`OVERLAY_PORT` widget suite green. One commit, staged by path:
`audit: catch sites — document, louden, or justify every swallow`.

## Phase 2 — Silent no-op bridges and guards

The bug class that has actually shipped here, twice.

1. **Bridge names (152 `?.()` sites, focus on the `__<key>Host` family).** For every
   `window.__somethingHost?.(…)` and `frameWin(w)?.__something?.(…)` call in `overlay/*.html`
   and the canvas, verify the exact name against what the publisher actually assigns
   (`grep` both sides; the registry key is the contract — `__bindingChartHost`, not
   `__bindingHost`). A mismatch is a real bug: fix it and add a widget-suite assertion that
   the bridge is live (negative-controlled). For matched bridges, leave the `?.` — it's the
   right idiom for "host not mounted yet" — but where a bridge being absent at steady state
   is impossible-by-design, consider a one-shot dev-mode warning.
2. **`if (!x) return;` guards.** Classify each (missions.html's 40 first): (a) legitimate
   early-out on absent optional state — leave; (b) discarding DATA someone pushed — the
   `setWidgetVisible` class; convert to the pull pattern or louden. Before building anything,
   grep for an unused pull API that already exists (that's how `widgetStates()` was found).
3. **Fallback chains.** Image fallback chains must chain on a FLAG, never by comparing
   `img.src` (resolved-URL trap, already documented). Verify the existing chains still comply;
   flag any new one that doesn't.

**Verify:** widget suite green against repo sidecar; any fixed bridge demonstrated live
(drive the widget, observe the effect). Commit: `audit: verify every JS bridge name; no silent no-op calls`.

## Phase 3 — Redundancy

**3a. Within-file duplication (safe, do it).** The big inline-JS pages (`missions.html`,
`chat.html`, `mining.html`) and `overlay-server.ts` / `main.cjs`. Hunt: repeated 5+ line
blocks, copy-pasted branches that diverge by one value, the same computation done twice per
render. Consolidate within the file only. Match existing style; no new abstraction layers —
a local function shared by two call sites, not a framework.

**3b. Cross-page duplication (conservative — decide, don't default).** Every widget page is
deliberately self-contained: zero shared script tags, fonts bundled, `setup.html` keeps its
own copies on purpose. A shared `overlay/lib.js` would be a real architectural change AND has
a deployment coupling: widget pages are synced to the live product page
(`npm run sync:overlay-widgets`, pinned to release tags), so a new shared file must ride that
sync or the site embeds break. Current known duplication is small (`esc` in 3 pages, reconnect
wiring in ~5). **Rule: extract only if ≥3 pages share ≥15 lines of logic that has already
bitten once when the copies drifted. Otherwise document the duplication as deliberate in the
report — self-contained pages ARE the house style, and that's a defensible human answer to
the viewer, not a smell.** If you do extract, update the sync script and verify the embeds.
(Do NOT touch `setup.html`'s standalone copies in any case — documented as intentional.)

**3c. Dead code — inventory, then delete only what's proven dead.** Candidates from
planning: HAL's unused `c_unknown1..5` clips in `overlay/tts/` (documented unused since the
`unknown`-refusal change). For each candidate: grep `src/`, `overlay/`, `electron/`,
`tools/`, AND the subliminal-gg repo's `lib/sc-overlay/` (the site embeds these pages —
"dead" here may be alive there). Anything you can't prove dead across both repos goes in the
report, not the trash. Do not remove pre-existing dead code that's documented as
kept-on-purpose (fallback paths like the PowerShell foreground watcher are deliberate).

**Verify:** suite green; for any deleted file, a packaged-layout check if it was shipped in
the asar. Commits per sub-phase, staged by path.

## Phase 4 — Impossible-scenario handling & speculative surface

Sub's own guideline: "No error handling for impossible scenarios. No flexibility that wasn't
requested." Sweep for:

- Guards on states the type system or call graph already excludes (prove it before deleting;
  when the proof is long, the guard is cheaper than the proof — leave it and move on).
- Config keys / options nothing reads (grep all four dirs + site repo). Known and EXCLUDED:
  `payoutCalculated` / `payoutModel` (release-gate decision, Sub's). Report any others;
  delete only with Sub-visible provenance in the report.
- Defensive re-validation of data the same process produced two lines earlier.

This phase is **report-heavy, edit-light**. The failure mode to avoid: deleting a guard that
looks impossible but exists because of a documented incident (this repo has many — the skill
file is the ledger; check it before every deletion).

## Phase 5 — Verification sweep & the audit report

1. Full sweep: `npx tsc --noEmit` · `node --check tools/widget-dom-test.cjs` ·
   `OVERLAY_PORT=<n> npm run test:widgets` (24 suites) · `npm run test:mining` ·
   `npm run test:location` · `npm run test:handover` · `npm run test:glyph` ·
   `npm run test:classify` · `npm run test:feedback` · `npm run test:logenv` ·
   `npm run test:repaccrual`. Known flaky/pre-existing: the capture-404 fallback suite fails
   ~1 in 3 (timing); `test:logpaths` fails at HEAD in some environments. Don't chase those;
   don't let them hide a real regression either — re-run before concluding.
2. Write **`AUDIT-REPORT-error-handling-redundancy.md`** (repo root, untracked, same
   keep-out-of-commits rule):
   - Before/after numbers for every census metric.
   - Per-rubric counts: how many sites KEEP / DOCUMENT / LOUDEN / PROPAGATE / DELETE, with
     file:line for every non-KEEP.
   - The "deliberately kept" list with one-line reasons — this is the half Sub can actually
     use on stream: the error handling that remains is there because a named incident proved
     it necessary, and the duplication that remains is a self-containment decision, not an
     accident.
   - Anything found but not touched (dead-code candidates, unreadable config keys, a health
     check vouching wrong) as a punch list for Sub.
3. Leave the working tree with only your commits (by path) plus the two untracked audit files.
   Do not release; do not bump the version. 0.1.43 is Sub's move.

## Success criteria (the loop-until-done list)

- [ ] Zero catch sites without either a why-comment or a loud path. (`grep` for the empty
      patterns above returns only commented sites.)
- [ ] Every `__<key>Host` bridge name verified against its publisher; mismatches fixed with a
      negative-controlled assertion each.
- [ ] Every catch-to-default site has a stated answer to "which way should ignorance fail?"
- [ ] No within-file duplicated block ≥5 lines survives in the four biggest files without a
      reason in the report.
- [ ] Full test sweep green (modulo the two documented pre-existing failures).
- [ ] `AUDIT-REPORT-…md` written, with before/after numbers.
- [ ] Nothing staged or committed that isn't yours; both audit .md files untracked.
