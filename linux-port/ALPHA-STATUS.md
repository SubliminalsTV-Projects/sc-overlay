# r31 Alpha 13 status

This branch targets ArchVerse Overlay 0.1.36-r31 for Arch Linux and CachyOS.

Alpha 13 is the focused efficiency and first-run usability checkpoint. It keeps Alpha 12's
explicit Linux interaction ownership contract while reducing idle polling and native OCR work.

Release gates:

- all Alpha 2–13 Linux interaction and efficiency regression tests pass;
- TypeScript typechecking and the eight server test files pass;
- OCR cycles are completion-scheduled and visually unchanged stages are skipped;
- mission, mining, and fabricator readers are opt-in on fresh installs;
- Lightweight, Balanced, and Mining profiles plus live OCR status are exposed in Settings;
- the successful capture backend is cached for the session;
- widget-region and normal host-pointer updates are event-driven;
- the exact production OCR/input dependency tree is bundled in the archive;
- both tar.gz and zip assets, plus SHA-256 checksums, are produced;
- the tag `v0.1.36-r31-alpha.13` publishes a GitHub prerelease.

Alpha 12 remains the rollback checkpoint. Stable `main` is not changed by this release.
