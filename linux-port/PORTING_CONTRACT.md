# ArchVerse Linux Upstream Porting Contract

This document defines the minimum engineering and validation contract for rebasing the ArchVerse
Linux port of SC Overlay onto a newer upstream release. It exists because the Alpha 17 -> upstream
0.1.41 jump demonstrated that a merge can be syntactically valid and still be runtime-invalid.

## 1. High-churn runtime files are not line-merged as finished code

`electron/main.cjs` and `electron/capture.cjs` are high-risk integration surfaces. Upstream and the
Linux fork both make architectural changes inside these files, so a successful `git merge-file` or a
clean diff is **not** sufficient evidence that the result is coherent.

For these files:

1. Use the upstream version as the authoritative implementation of new upstream behavior.
2. Reapply Linux behavior at explicit semantic seams.
3. Treat diff3/three-way output only as an intermediate reconstruction aid.
4. Run lexical, runtime, package, IPC, renderer and Linux-contract audits before a candidate can be
   considered releasable.

Every field regression discovered after a merge becomes a permanent CI invariant or smoke test.

## 2. Linux-owned behavior that upstream updates may not silently replace

The following are ArchVerse platform contracts:

- **F** is the mandatory interaction key on Linux.
- **Hold-to-interact is enabled** on Linux.
- **Shift+F6** is the Linux arrange/move hotkey.
- The interaction gate is registered before overlay creation so Star Citizen can retain initial
  focus.
- Transparent canvas windows remain hard click-through outside explicit interaction ownership.
- Physical mouse movement/button forwarding remains the source of truth during held-F interaction.
- The one-native-cursor design remains; a synthetic second visible cursor must not return.
- KDE/X11/Gamescope focus handoff and verified pointer handoff remain.
- Exact `StarCitizen.exe` session binding remains the privacy/foreground gate for capture.
- Linux capture backends/fallbacks remain available.
- RapidOCR remains isolated in a disposable Node child process with bounded queue/thread resources.
- OpenGL remains the normal Linux renderer, with software Safe Mode as the fallback.

## 3. Mining integration rule

The newest upstream mining scanner is authoritative **behind** the ArchVerse structural Scan Mode
gate.

The gate must remain:

- structural/pixel based;
- independent of ship type;
- independent of HUD color;
- independent of OCR text;
- independent of Prospector-specific assumptions;
- validated by the labeled Scan Mode on/off and false-positive fixture corpus.

When Scan Mode is structurally inactive, mining-only signature/analysis OCR must remain dormant.
Other explicitly enabled features such as mission or fabricator OCR may still perform the work they
need, but their results may not be allowed to masquerade as a mining signature while the gate is
off.

Scan Mode diagnostics must remain bounded and persistent under the canonical Linux config directory.
When mining diagnostics are explicitly enabled, the package must retain an exact match crop, a wider
context crop and the structural metrics/rejection reason needed to diagnose a false positive or
false negative.

## 4. Config ownership

All Linux processes use one physical config root:

`SC_TRACKER_CONFIG_DIR`

The Electron shell sets it and the sidecar consumes it. A stale HOME/APPDATA-style legacy config may
not silently override it.

The public config API must repair these platform-owned values before persisting on Linux even if a
caller attempts to change them:

- `interactHotkey = "F"`
- `holdToInteract = true`
- `moveHotkey = "Shift+F6"`

The screen-reader profile is **not** a locked Linux platform setting. A fresh Linux config may begin
at `lightweight`, but the user must be able to select Balanced, Mining, or another valid reader
combination. `screenReaderProfile` is descriptive state derived from the actual reader toggles and
must remain coherent with them:

- `lightweight`: Fabricator off, Mission OCR off, Mining Assistant off
- `balanced`: Fabricator off, Mission OCR on, Mining Assistant off
- `mining`: Fabricator off, Mission OCR off, Mining Assistant on
- `custom`: every other combination

The Settings page and `/api/config` must use the same truth table. The POST response must report the
**applied** screen-reader state (`fabCapture`, `missionOcr`, `miningAssistant`, and derived profile)
so Settings can verify the save rather than reporting a false failure after a successful write.

## 5. Release quarantine

A green compile is not a release approval.

During a significant upstream rebase:

1. Build an internal candidate artifact.
2. Keep publication disabled.
3. Run the complete validation matrix below against both the generated tree and the packaged tree
   where applicable.
4. Only re-enable publication in a separate, deliberate release-approval commit after all gates are
   green.

The prior release remains the rollback point until real in-game testing of the new candidate is
complete.

## 6. Required validation matrix

### Source/upstream tests

- Electron/CommonJS syntax checks.
- TypeScript `tsc --noEmit`.
- Full upstream test suite.
- Production `server.mjs` build.

### JavaScript merge audits

- `allowJs/checkJs` lexical scan for undefined bindings, duplicate/redeclared identifiers and use
  before declaration.
- Reject duplicate top-level function declarations.
- Reject duplicate `ipcMain.handle/on/once` registrations.
- Verify every relative CommonJS dependency exists in the package.
- Evaluate `capture.cjs` under a controlled Electron stub; syntax-only checking is insufficient.

### IPC and renderer audits

- Every preload `ipcRenderer.invoke()` has a matching `ipcMain.handle()`.
- Every preload `ipcRenderer.send()` has a matching `ipcMain.on/once()`.
- Parse every overlay HTML file.
- Syntax-check every inline renderer script.
- Reject duplicate DOM IDs.
- Parse bundled JSON resources.

### Runtime/package smoke tests

- Execute generated and packaged `main.cjs` under controlled Electron stubs.
- Exercise `app.whenReady()`, canvas creation, renderer-ready callback, sidecar spawn contract and
  IPC registration.
- Launch the actual packaged `server.mjs` on an isolated port and verify identity, missions API and
  HUD page endpoints.
- Verify archive checksums after staging.

### Linux regression tests

Re-run the still-applicable proven Alpha 17 tests against the new candidate, including:

- exact Star Citizen session binding;
- renderer region handshake;
- stable held-F interaction;
- verified focus/pointer handoff;
- idle pointer pinning;
- explicit interaction ownership;
- physical click forwarding;
- structural radar/Scan Mode behavior.

The four labeled Alpha 17 Scan Mode fixtures are part of the permanent detector regression corpus.

Also assert current equivalents for architecture-sensitive contracts rather than relying only on
old source-text regexes when upstream legitimately changes implementation shape.

### Config E2E

Launch the actual packaged sidecar with an isolated canonical config directory and:

- verify diagnostics report the canonical config path;
- verify a conflicting legacy HOME config is not adopted;
- attempt to overwrite F/hold/Shift+F6 through `/api/config`;
- verify the API response and saved `config.json` repair those platform controls;
- exercise at least two non-default reader states (for example Mining and Balanced);
- verify `/api/config` returns the applied `screenReading` state that Settings verifies;
- verify the derived profile matches the actual reader booleans in the POST response, subsequent
  GET response, and persisted `config.json`;
- verify packaged Linux can explicitly opt into bounded Mining diagnostics;
- verify the sidecar remains alive.

## 7. Upgrade cadence

When practical, port upstream releases incrementally instead of skipping many tags at once. For a
large unavoidable jump:

- compare each intervening upstream release/commit group;
- classify changes by subsystem before merging;
- rebuild high-risk files semantically;
- keep automatic publication disabled throughout integration;
- produce internal candidates only until the entire validation matrix is green.

The goal is not to avoid upstream change. The goal is to ensure that upstream functionality and the
Linux platform contracts are combined intentionally rather than accidentally by textual conflict
resolution.
