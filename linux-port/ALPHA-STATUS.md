# r31 Alpha 16 status

This branch targets ArchVerse Overlay 0.1.36-r31 for Arch Linux and CachyOS.

Alpha 16 keeps the verified F focus/latch path, repairs the physical mouse-button route that failed
after the latch, removes the extra cursor window, and makes Scan Mode recognition a ship-independent
radar-icon search. It preserves Alpha 14's configuration, thread budget, OpenGL default, and dormant
mining-stage improvements.

Release gates:

- all Alpha 2–16 Linux interaction, efficiency, resource-budget, and detector tests pass;
- the built and packaged sidecar pass config migration/save/reload and mandatory-F checks;
- TypeScript typechecking and all server test files pass;
- Linux always registers F and ignores migrated or live attempts to disable its entry gate;
- the canonical Linux config self-repairs `holdToInteract: true` and `interactHotkey: "F"`;
- global physical mouse move/down/up events reach the appropriate overlay or embedded WebContents;
- a correctly positioned native event cancels the synthetic fallback so checkboxes cannot double-toggle;
- explicit down/up cleanup prevents a stuck button when interaction ends mid-gesture;
- no second cursor BrowserWindow exists;
- Scan Mode is detected solely from the shared radar icon across a broad position/scale search field;
- the detector has no ship, fixed-coordinate HUD color, ping, target-text, or OCR dependency;
- normal cockpit and active Scan Mode references pass the template matcher;
- Scan Mode gating is in memory and creates no OCR worker, Tesseract, ImageMagick, or PNG work;
- Mining Analysis and Signature OCR stay dormant until the Scan Mode gate succeeds;
- OCR diagnostics retain eight recent frame/result pairs and app log entries have timestamps;
- RapidOCR remains capped at two ONNX threads and Tesseract/ImageMagick at one thread;
- mission, mining, and fabricator readers remain opt-in on fresh installs;
- the exact production OCR/input dependency tree is bundled in the archive;
- both tar.gz and zip assets, plus SHA-256 checksums, are produced;
- OpenGL remains the Linux default and software rendering remains an explicit Safe Mode;
- the tag `v0.1.36-r31-alpha.16` publishes a GitHub prerelease.

Alpha 15 remains the immediate rollback checkpoint. Stable `main` is not changed by this release.
