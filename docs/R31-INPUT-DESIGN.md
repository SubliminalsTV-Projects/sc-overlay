# r31 input design decision

## Accepted short-term behavior

ArchVerse Overlay 0.1.36-r31 will reserve the **F key entirely for Star Citizen**.

- `F` is never used by ArchVerse for overlay interaction.
- **Right Alt** is the default hold-to-interact key.
- Releasing Right Alt immediately restores click-through unless a required modal is open.
- `Ctrl+Alt+M` remains the original upstream arrange/move shortcut.
- `Escape` immediately restores click-through and exits temporary interaction state.
- Required startup and What's New dialogs become interactive automatically without a hotkey.
- The interaction binding will be configurable so users can select another keyboard key, mouse button, or evdev input later.

This avoids conflicts with Star Citizen's hold-F interaction system, especially when Gamescope owns or confines the pointer.

## Deferred long-term design

Investigate widget-shaped Linux input regions so that:

- transparent canvas areas always pass clicks to Star Citizen;
- only visible widget rectangles accept pointer input;
- ordinary widget use no longer requires a hold-to-interact key.

Potential implementations include separate native windows per widget, X11 Shape/Input regions, or a Wayland layer-shell/native helper. This is intentionally deferred until the 0.1.36 Arch/Fedora port is stable.
