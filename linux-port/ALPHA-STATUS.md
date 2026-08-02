# r31 Alpha 14 status

This branch targets ArchVerse Overlay 0.1.36-r31 for Arch Linux and CachyOS.

Alpha 14 is the resource-budget and configuration-reliability checkpoint. It keeps Alpha 12/13's
explicit Linux interaction ownership contract while fixing the Alpha 13 profile-save split and
preventing native OCR libraries from taking over a many-core processor.

Release gates:

- all Alpha 2–14 Linux interaction, efficiency, and resource-budget regression tests pass;
- the built and packaged sidecar pass an end-to-end config migration/save/reload test;
- TypeScript typechecking and the eight server test files pass;
- Settings, Electron, and capture use the same `SC_TRACKER_CONFIG_DIR` path;
- Alpha 13's legacy config is merged once, backed up, and never deleted;
- RapidOCR is capped at two ONNX threads and Tesseract/ImageMagick at one thread;
- Scan Mode uses a bounded OCR angle gate instead of missing template files;
- Mining Analysis and Signature OCR stay dormant until the gate succeeds;
- the inactive 15-second signature safety probe is removed;
- mission, mining, and fabricator readers are opt-in on fresh installs;
- Lightweight, Balanced, and Mining profiles plus live OCR status are exposed in Settings;
- the successful capture backend is cached for the session;
- widget-region and normal host-pointer updates are event-driven;
- the exact production OCR/input dependency tree is bundled in the archive;
- both tar.gz and zip assets, plus SHA-256 checksums, are produced;
- OpenGL is the Linux default and software rendering remains an explicit Safe Mode;
- the tag `v0.1.36-r31-alpha.14` publishes a GitHub prerelease.

Alpha 13 remains the rollback checkpoint. Stable `main` is not changed by this release.
