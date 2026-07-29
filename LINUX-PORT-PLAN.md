# ArchVerse Overlay 0.1.34-r31 Linux port plan

This integration branch starts from upstream SC Overlay 0.1.34 and adds the
ArchVerse Linux portability layer without modifying the stable Linux release
until verification and in-game testing are complete.

## Upstream baseline

- [x] Start from upstream release commit `7dbcbb70c40be56f3a985d1a7d11bdb01606af6d`.
- [ ] Preserve the complete upstream 0.1.34 widget canvas and feature set.
- [ ] Preserve upstream RapidOCR support and model-loading behavior.
- [ ] Record upstream-versus-r30 changed-file inventory.

## Linux runtime

- [ ] Replace Windows foreground-window APIs with Linux session/window discovery.
- [ ] Support KDE Plasma Wayland, KDE Plasma X11, and GNOME Wayland.
- [ ] Preserve Gamescope and Star Citizen PID/session binding.
- [ ] Preserve multi-monitor canvas geometry and portrait-monitor layouts.
- [ ] Retain upstream `Ctrl+Alt+M` arrange mode as the only arrange shortcut.
- [ ] Keep Shift+F5 and Shift+F6 removed.
- [ ] Make held-F interaction global and independent of Star Citizen focus.
- [ ] Ensure modal dialogs, including What's New, temporarily override click-through.

## Screen capture and OCR

- [ ] Use RapidOCR/PP-OCR as the preferred text engine.
- [ ] Keep Tesseract as a focused numeric/preprocessed fallback.
- [ ] KDE Wayland capture through Spectacle when available.
- [ ] GNOME Wayland capture through Electron/XDG Desktop Portal.
- [ ] X11 capture through Electron desktopCapturer with fallback tooling.
- [ ] Preserve exact Mining signature whitelist behavior.
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
- [ ] Preserve user configuration, widget positions, notes, Mining selections, and backups during upgrades.

## Verification gates

- [ ] Upstream unit and widget tests pass unchanged where platform-neutral.
- [ ] Arch/CachyOS installer verification passes.
- [ ] Fedora installer verification passes in a clean Fedora environment.
- [ ] JavaScript and shell syntax checks pass.
- [ ] RapidOCR initialization and fallback paths are tested.
- [ ] Modal click-through regression test passes.
- [ ] Global held-F regression test passes.
- [ ] Ctrl+Alt+M arrange regression test passes.
- [ ] Multi-monitor geometry tests pass.
- [ ] Mining OCR and Scan Mode tests pass.
- [ ] Create a test release before changing `main`.

## Release policy

`main` and the current stable GitHub Release remain unchanged until the r31
integration branch passes automated verification and receives an in-game test
on at least one Arch/CachyOS system and one Fedora system.
