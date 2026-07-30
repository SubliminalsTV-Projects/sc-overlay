# r31 alpha build status

This branch targets ArchVerse Overlay 0.1.36-r31.

The first alpha checkpoint is intentionally limited to Arch Linux/CachyOS so the existing test system can validate the upstream rebase and Linux runtime before Fedora packaging is added.

Alpha 1 gates:

- upstream 0.1.36 server and web assets build;
- Linux Electron core changes merge without unresolved markers;
- Gamescope/session and multi-monitor Linux modules are present;
- RapidOCR runs through the isolated worker client;
- F is not the overlay interaction key;
- Right Alt is the default hold-to-interact key;
- Ctrl+Alt+M remains arrange mode;
- an installable archive and SHA-256 file are produced by CI.

Stable `main` is not changed by this build.
