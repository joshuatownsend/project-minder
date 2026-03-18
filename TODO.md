# TODO

## Dashboard Features

- [x] **Hide projects UI** — Three-dot menu on cards with "Hide" action, "(N hidden)" link opens manage modal to unhide.
- [ ] **Configurable DEV_ROOT** — `C:\dev` is hardcoded in `src/lib/scanner/index.ts`. Allow setting it via `.minder.json` or an env var so the tool works on other machines.

## Performance

- [ ] **Background git dirty status** — `git status --porcelain` is too slow on Windows across 61 repos (~2s each). Currently hardcoded to `false`. Needs a lazy/background approach — e.g., run on detail page visit only, or queue checks in batches with a stale indicator.

## Housekeeping

- [x] **Create CHANGELOG.md** — Set up with Keep a Changelog format.
- [x] **Use dropdown menu dep** — `@radix-ui/react-dropdown-menu` now used for project card action menu.
- [ ] **Remove `@radix-ui/react-separator`** — Still unused. Either find a use or remove it.
