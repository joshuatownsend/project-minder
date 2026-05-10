# Keyboard Shortcuts

Project Minder has global keyboard shortcuts for fast navigation and actions.

## Default shortcuts

| Action | Default key |
|--------|-------------|
| Focus search | `/` |
| Quick-add project | `Shift+T` |
| Cycle view mode | `v` |
| Rescan projects | `r` |
| Open help | `?` |
| Command palette | `Ctrl+K` |

Shortcuts are suppressed when focus is in an input, textarea, or select field.

## Customizing shortcuts

Go to **Settings → Appearance** to customize any shortcut:

1. Click **Edit** on the action you want to change.
2. The row enters capture mode — press the key combination you want.
3. Click **Save** to apply, or **Cancel** to discard.
4. Use **Reset to defaults** to restore all shortcuts to their original values.

## Constraints

- Combos must use a single character, optionally prefixed with `Ctrl+`, `Meta+`, `Alt+`, or `Shift+`.
- No two actions can share the same combo. The server rejects conflicting assignments.
- On macOS, use `Meta+K` for command-style shortcuts; on Windows/Linux, use `Ctrl+K`.
