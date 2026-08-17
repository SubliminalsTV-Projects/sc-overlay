# Audit report: error handling & redundancy (SC Overlay)

**Executed 2026-08-14** on branch `audit/error-handling-redundancy` (worktree off `26dbff2`,
the 0.1.43 release commit). Targets the 0.1.44 cycle. Keep this file and the companion plan
out of commits.

## The claim being tested

A livestream viewer: *"does your app contain error handling or redundancy? this is usually
how I can tell AI code from human coding."*

The audit's standard (stricter than the viewer's): **every failure path must be deliberate —
handled with a stated reason, surfaced loudly, or gone; every duplication justified or gone.**
Silent error handling is the actual AI-code tell. Error handling *itself* is not — this app's
incident history proves the opposite: its worst shipped bugs (the stuck drag lock, the dead
RapidOCR engine in 0.1.42, the invisible widget startup) were all failures that were
*swallowed*, not failures that were handled.

## Headline numbers

| Metric | Before | After |
|---|---|---|
| `catch` sites across shipped code (~35k lines) | 433 | 433 (no handler removed, none added) |
| Silent catches with **no stated reason** | ~20 | **0** — every swallow now says why it may swallow |
| Bridge-name mismatches (`__<key>Host` family, 30+ bridges paired) | 1 latent bug class | **0** — every name verified against its publisher |
| Widgets that leak the canvas-wide keyboard grab when hidden mid-typing | **2** (Twitch Chat, Web Page) | **0** — fixed + negative-controlled test |
| Verbatim duplicated blocks ≥6 lines, 7 biggest files | 0 | 0 |
| Verbatim duplicated blocks ≥4 lines | 4 (all false positives — see below) | 4, deliberately |
| Config fields nothing reads (of 73) | 0 | 0 |
| Dead assets | 8 retired HAL voice clips | kept **deliberately**, now all named in the keep-comment |

## What was found and changed

### 1. One real bug: the typing-grab leak (fixed, `8235358`)

Pairing every `__<key>*` bridge against its publisher found that `twitchchat.html` and
`webview.html` both **define** `__<key>ExitTyping` and the canvas **never called it** — while
notepad, party, and chat all release the typing grab in `onHide`. Typing arms a canvas-wide
keyboard grab, and hiding a widget *unloads its iframe*, so a widget hidden mid-typing leaked
the grab with no page left to lower it: the overlay eats clicks and keys on every display and
nothing on screen says why. Same family as the 2026-08-09 chat grab bug and the drag-lock bug
fixed in 0.1.43.

New suite `typing grab: hiding releases it` (7 assertions), negative-controlled: with the
twitchChat fix disabled, exactly the one expected assertion goes red; with it in place, green.

### 2. Silent catches: documented, not deleted (`4765ce5`)

Of 433 catch sites, the large majority already carried a why-comment — that is the house
style, and it is exactly right. The ~20 undocumented ones were each classified
(KEEP / DOCUMENT / LOUDEN / PROPAGATE / DELETE). **All resolved to DOCUMENT or KEEP — none
needed loudening**, because in every case the loud path already existed elsewhere:

- The auto-updater's `.catch(() => {})` — failures already surface via its `error` handler;
  the catch only silences duplicate unhandled-rejection noise. Now says so.
- The mission-report feedback POST — self-healing by construction (`saved` stays false so the
  card never claims a save; any later answer click re-posts all three fields). Now says so.
- `capture.cjs` gained a header stating the console-is-void rule: `console.*` there is
  dev-only (the packaged app has no stdout); anything that can fail *persistently* must use a
  loud path (`reportRapidFailure` → the widget, the heartbeat diagnostics, a logged request
  field). The transient warns beside sidecar POSTs are fine — the next tick retries them.
- Audio/TTS catches in mining and SC Feed — best-effort by design; silence is the fallback.

### 3. Redundancy: essentially none, and what exists is a decision (`e75b6c5`)

A duplicate-block detector (normalized 6-line and 4-line windows) over the seven biggest
files found **zero 6-line duplicates and four 4-line hits**, all false positives:
two Twitch OAuth calls that are *different grant flows* sharing fetch boilerplate, and two
port-safety functions (`reclaimStalePort` / `waitForServer`) whose similar shape carries
deliberately different failure semantics — one leaves a foreign process alone, one retries.
Collapsing either would hide the difference that matters.

Cross-page duplication (an `esc` helper in 3 pages, a 2-line `ensureActx` in 2, per-page SSE
reconnect wiring) is **deliberate architecture, not accident**: every widget page is fully
self-contained — zero shared script tags, fonts bundled — because these pages are served into
OBS browser sources, the product-page embeds, and third-party hosts, where a shared-file
dependency is a new way to break nine pages at once. None of it meets the extract bar
(≥3 pages sharing ≥15 lines that have drifted apart and bitten).

### 4. Speculative surface: none found

- All **73 config fields** have live readers — no speculative options.
- The `if (!x) return;` guard sweep (40 in the canvas page alone) found only re-runnable
  render/event early-outs — no one-shot data drops. The one historically dangerous site
  (`setWidgetVisible`) already carries the pull-pattern fix and a comment naming the trap.
- Both image fallback chains comply with the flag rule (never compare `img.src`).
- Retired HAL voice clips (5 × `c_unknown`, plus `c_breaking` / `c_debrisor` /
  `c_thiscouldbe`) stay on disk **on purpose** — regenerating HAL audio (piper, on another
  machine) costs far more than the ~kilobytes they occupy. The keep-comment now names all of
  them, so none reads as forgotten.

## Follow-up build: the logging gaps (same branch, for 0.1.44)

The audit's diagnosability review found three gaps, and Sub asked for all three:

1. **`sidecar-prev.log`** — the shell now keeps one previous generation before truncating on
   launch, so "restart the app" (the first thing every user tries) no longer destroys the log
   that covers the incident being reported.
2. **Error capture where none existed** — the canvas forwards `window.onerror` /
   `unhandledrejection` to a new `POST /api/client-error` (budgeted and deduped client-side,
   rate-limited and ring-buffered server-side; the POST method puts it behind the existing
   loopback + Origin mutating gate automatically). The shell logs `render-process-gone` /
   `child-process-gone` into sidecar.log — the tray-menu-crash class of silent death now
   leaves a line.
3. **Copy diagnostics carries history, not just state** — the paste now includes recent UI
   errors and the last 60 lines of sidecar.log, with the sync/Twitch tokens redacted **by
   value** server-side so the report's "no passwords or tokens" promise still holds; and an
   **Open logs folder** button sits beside it (via the existing `openDataFolder` allowlist).

Tested: new `npm run test:clienterror` (9 assertions against a real spawned sidecar — intake,
diagnostics round-trip, garbage body, flood → 429 + capped buffer, tail present, token
redacted), written first and seen red before the route existed; plus a new widget suite
`client errors reach the sidecar` driving a synthetic ErrorEvent end-to-end through the real
route, negative-controlled.

## Known-and-excluded (pre-existing, someone else's call)

- **The 2,045 modelled payouts rendering as fact** (`payoutCalculated` is read by nothing) —
  flagged in the handoff as a 0.1.43 release gate; explicitly out of this audit's scope.
- `test:logpaths` fails at HEAD in some environments (pre-existing, documented in handoff).
- The capture-404 fallback widget assertion is flaky ~1 in 3 (fixed 500ms sleep, documented).

## Verification

- `tsc --noEmit` clean after every phase.
- Full widget suite (25 suites now) green against a worktree sidecar on :8781 — including the
  new grab suite, which was also seen **red** under the deliberately re-injected regression
  before being trusted.
- src suites, all run in the worktree: **14 of 15 pass** — glyph 13/13, classify (4,075
  missions, 56.2% derived), feedback, fabclaim, logenv, mining, report, screenocr, repaccrual,
  handover, logshare, chat (98 automod assertions), location 30/30, contracts. The one
  failure is `test:logpaths`, pre-existing at HEAD and documented in the handoff as
  environment-dependent.
- `node --check` on the widget suite before every run (the backtick trap).

## The honest answer for the viewer

The app has 433 error-handling sites, and after this audit **zero of them are silent without
a stated reason** — most of them are there because a specific, documented incident proved the
failure real (the repo's comments cite the incidents by date). Mechanical duplication across
35,000 lines: zero blocks of six lines or more. The duplication that does exist — a 3-line
HTML-escape helper appearing in three widget pages — is the cost of a deliberate decision
that every widget page be embeddable standalone with no shared dependencies. That trade-off
is written down. That's what distinguishes engineering from generation: not the absence of
error handling, but that every error path and every duplication can explain itself.
