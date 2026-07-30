# ArchVerse Overlay 0.1.36-r31 Linux port plan

This integration branch starts from upstream SC Overlay 0.1.36 and adds the
ArchVerse Linux portability layer without modifying the stable Linux release
until verification and in-game testing are complete.

Upstream 0.1.36 contains the full 0.1.35 feature release plus its immediate
sidecar-window hotfix. The Windows-only `windowsHide` correction is retained in
the baseline even though Linux uses a different sidecar launch path.

## Upstream baseline

- [x] Start from upstream commit `085018c76f8428dbfc8b40ee9a430ddc5965b2f2`.
- [x] Include all 35 upstream commits added after the 0.1.34 release commit.
- [ ] Preserve the complete upstream 0.1.36 widget canvas and feature set.
- [ ] Preserve upstream RapidOCR support and model-loading behavior.
- [ ] Preserve the 0.1.35 mining, mission, progression, webview, chat, diagnostics, and configuration changes.
- [ ] Preserve the movable/resizable Mining scan-read region and its reset behavior.
- [ ] Preserve faster scan polling, legal-signature validation, 6/8 correction, debris classification, and announcement controls.
- [ ] Record the complete upstream-versus-r30.2 changed-file inventory.

## Linux runtime

- [ ] Replace Windows foreground-window APIs with Linux session/window discovery.
- [ ] Support KDE Plasma Wayland, KDE Plasma X11, and GNOME Wayland.
- [ ] Preserve Gamescope and Star Citizen PID/session binding.
- [ ] Preserve multi-monitor canvas geometry and portrait-monitor layouts.
- [ ] Retain upstream `Ctrl+Alt+M` arrange mode as the only arrange shortcut.
- [ ] Keep Shift+F5 and Shift+F6 removed.
- [ ] Reserve `F` entirely for Star Citizen.
- [ ] Use Right Alt as the default global hold-to-interact key.
- [ ] Make the interaction binding configurable for keyboard, mouse, or evdev inputs.
- [ ] Ensure modal dialogs, including What's New, temporarily override click-through.
- [ ] Make `Escape` immediately restore click-through and leave temporary interaction state.

## Screen capture and OCR

- [ ] Run RapidOCR/PP-OCR in an isolated worker process so a Sharp/libvips abort cannot terminate Electron.
- [ ] Keep Tesseract as a focused numeric/preprocessed fallback.
- [ ] KDE Wayland capture through Spectacle when available.
- [ ] GNOME Wayland capture through Electron/XDG Desktop Portal.
- [ ] X11 capture through Electron desktopCapturer with fallback tooling.
- [ ] Integrate upstream's configurable scan-read region with Linux capture coordinates.
- [ ] Preserve exact Mining signature whitelist behavior.
- [ ] Preserve upstream legal-signature validation and one-digit 6/8 repair constraints.
- [ ] Preserve six-angle Scan Mode templates.
- [ ] Improve Scan Mode location search for non-Prospector cockpits.
- [ ] Keep audio and desktop notifications gated by confirmed Scan Mode.

## Distribution support

- [ ] Add `install-linux.sh` distribution dispatcher.
- [ ] Add `install-arch.sh` for Arch Linux and CachyOS.
- [ ] Add `install-fedora.sh` for Fedora KDE and Fedora Workstation.
- [ ] Add matching uninstall and doctor paths.
- [ ] Detect and report missing evdev permissions without unsafe broad permissions.
- [ ] Package or pin a compatible Electron runtime rather than relying on a distro-specific Electron package number.
- [ ] Preserve user configuration, widget positions, notes, Mining selections, scan-region settings, and backups during upgrades.

## Verification gates

- [ ] Upstream unit and widget tests pass unchanged where platform-neutral.
- [ ] Upstream Mining classifier, announcement, glyph, and scan-region tests pass.
- [ ] Arch/CachyOS installer verification passes.
- [ ] Fedora installer verification passes in a clean Fedora environment.
- [ ] JavaScript and shell syntax checks pass.
- [ ] RapidOCR worker crash-containment and Tesseract fallback tests pass.
- [ ] Modal click-through regression test passes.
- [ ] Right-Alt interaction regression test passes.
- [ ] Confirm `F` is never consumed by ArchVerse.
- [ ] `Ctrl+Alt+M` arrange regression test passes.
- [ ] Multi-monitor geometry tests pass.
- [ ] Mining OCR, movable scan region, and Scan Mode tests pass.
- [ ] Create a test release before changing `main`.

## Release policy

`main` and the current stable GitHub Release remain unchanged until the r31
integration branch passes automated verification and receives an in-game test
on at least one Arch/CachyOS system and one Fedora system.
