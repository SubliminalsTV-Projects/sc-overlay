# r31 Alpha 15 status

This branch targets ArchVerse Overlay 0.1.36-r31 for Arch Linux and CachyOS.

Alpha 15 repairs the Linux F interaction regression and replaces Alpha 14's ineffective cone-angle
OCR with a calibrated, in-memory Prospector Scan Mode gate. It preserves Alpha 14's configuration,
thread-budget, OpenGL, and dormant-mining-stage improvements.

Release gates:

- all Alpha 2–15 Linux interaction, efficiency, resource-budget, and detector tests pass;
- the built and packaged sidecar pass config migration/save/reload and mandatory-F checks;
- TypeScript typechecking and all server test files pass;
- Linux always registers F and ignores migrated or live attempts to disable its entry gate;
- the canonical Linux config self-repairs `holdToInteract: true` and `interactHotkey: "F"`;
- Scan Mode is detected from the fixed Prospector cone control before a ping or target exists;
- normal cockpit, no-ping Scan Mode, and pinged Scan Mode references pass the calibrated thresholds;
- Scan Mode gating is in memory and creates no OCR worker, Tesseract, ImageMagick, or PNG work;
- Mining Analysis and Signature OCR stay dormant until the Scan Mode gate succeeds;
- OCR diagnostics retain eight recent frame/result pairs and app log entries have timestamps;
- RapidOCR remains capped at two ONNX threads and Tesseract/ImageMagick at one thread;
- mission, mining, and fabricator readers remain opt-in on fresh installs;
- the exact production OCR/input dependency tree is bundled in the archive;
- both tar.gz and zip assets, plus SHA-256 checksums, are produced;
- OpenGL remains the Linux default and software rendering remains an explicit Safe Mode;
- the tag `v0.1.36-r31-alpha.15` publishes a GitHub prerelease.

Alpha 14 remains the rollback checkpoint. Stable `main` is not changed by this release.
