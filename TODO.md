# TODO

## Dashboard Features

- [x] **Hide projects UI** — Three-dot menu on cards with "Hide" action, "(N hidden)" link opens manage modal to unhide.
- [x] **Configurable DEV_ROOT** — Set `devRoot` in `.minder.json` (defaults to `C:\dev`).

## Performance

- [x] **Background git dirty status** — Background batch worker checks repos 3 at a time, dashboard polls for results and shows amber `+N` indicators as they come in.

## Setup Guide

- [x] **Phase 2: Auto-apply setup to managed projects** — Add buttons on the Setup page (or Config/project cards) to apply Option 1 (append CLAUDE.md rules) or Option 2 (write hook scripts) directly to projects managed by Project Minder. Uses `POST /api/config` or a new `/api/setup/[slug]` route.

## Testing

- [ ] **Unit tests for `setupApply.ts`** — Cover idempotent apply logic with temp-dir fixtures: initial apply, re-apply (already-present), malformed `settings.local.json`, and partial hook presence/merge behavior.

## Housekeeping

- [x] **Create CHANGELOG.md** — Set up with Keep a Changelog format.
- [x] **Use dropdown menu dep** — `@radix-ui/react-dropdown-menu` now used for project card action menu.
- [x] **Remove `@radix-ui/react-separator`** — Uninstalled.
