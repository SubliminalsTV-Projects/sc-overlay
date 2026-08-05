# r31 Alpha 17 status

This branch targets ArchVerse Overlay 0.1.36-r31 for Arch Linux and CachyOS.

Alpha 17 keeps Alpha 16's verified F/click route and single normal cursor, then repairs the broad
Scan Mode matcher using the user's labeled and explicitly outlined full-desktop on/off frames. It
preserves Alpha 14's configuration, thread budget, OpenGL default, and dormant mining-stage
improvements.

Release gates:

- all Alpha 2–17 Linux interaction, efficiency, resource-budget, and detector tests pass;
- the built and packaged sidecar pass config migration/save/reload and mandatory-F checks;
- TypeScript typechecking and all server test files pass;
- Linux always registers F and ignores migrated or live attempts to disable its entry gate;
- the canonical Linux config self-repairs `holdToInteract: true` and `interactHotkey: "F"`;
- global physical mouse move/down/up events reach the appropriate overlay or embedded WebContents;
- a correctly positioned native event cancels the synthetic fallback so checkboxes cannot double-toggle;
- explicit down/up cleanup prevents a stuck button when interaction ends mid-gesture;
- no second cursor BrowserWindow exists;
- the universal Scan HUD field comes from the user's paired 6360x2560 frames and #ff0000 outlines;
- Scan Mode is detected solely from the shared radar control across a normalized position/scale field;
- candidates must contain the cone/icon and separated angle label and remain isolated in a bounded halo;
- Alpha 16's changelog-button and hangar-beam false positives are compact regression fixtures;
- the detector has no ship, Prospector HUD color, ping, target-text, or OCR dependency;
- normal cockpit, outlined Scan Mode off, Base Scan Mode, and active Scan Mode references all pass;
- Scan Mode gating is in memory and creates no OCR worker, Tesseract, ImageMagick, or PNG work;
- Mining Analysis and Signature OCR stay dormant until the Scan Mode gate succeeds;
- OCR diagnostics retain eight recent full frames, exact/context match crops, scores, and rejection reasons;
- RapidOCR remains capped at two ONNX threads and Tesseract/ImageMagick at one thread;
- mission, mining, and fabricator readers remain opt-in on fresh installs;
- the exact production OCR/input dependency tree is bundled in the archive;
- both tar.gz and zip assets, plus SHA-256 checksums, are produced;
- OpenGL remains the Linux default and software rendering remains an explicit Safe Mode;
- the tag `v0.1.36-r31-alpha.17` publishes a GitHub prerelease.

Alpha 16 remains the immediate rollback checkpoint. Stable `main` is not changed by this release.
