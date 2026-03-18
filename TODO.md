# TODO

## Dashboard Features

- [x] **Hide projects UI** — Three-dot menu on cards with "Hide" action, "(N hidden)" link opens manage modal to unhide.
- [ ] **Configurable DEV_ROOT** — `C:\dev` is hardcoded in `src/lib/scanner/index.ts`. Allow setting it via `.minder.json` or an env var so the tool works on other machines.

## Performance

- [x] **Background git dirty status** — Background batch worker checks repos 3 at a time, dashboard polls for results and shows amber `+N` indicators as they come in.

## Housekeeping

- [x] **Create CHANGELOG.md** — Set up with Keep a Changelog format.
- [x] **Use dropdown menu dep** — `@radix-ui/react-dropdown-menu` now used for project card action menu.
- [x] **Remove `@radix-ui/react-separator`** — Uninstalled.
