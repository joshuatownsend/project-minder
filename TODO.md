# TODO

## Dashboard Features

- [x] **Hide projects UI** — Three-dot menu on cards with "Hide" action, "(N hidden)" link opens manage modal to unhide.
- [x] **Configurable DEV_ROOT** — Set `devRoot` in `.minder.json` (defaults to `C:\dev`).
- [x] **Dashboard view modes** — Three-way toggle (full cards / compact cards / sparkline list) with `v` shortcut to cycle. Compact cards = distraction-free mode. Sparkline list = dense sortable table with 14-day session activity sparklines per row. View persists to `.minder.json`. See design brief in this conversation.
- [x] **Project pinning** — Pin/unpin projects from the three-dot menu (full/compact cards) or inline pin icon (sparkline list). Pinned projects float to top across all view modes. State persists to `.minder.json` as `pinnedSlugs[]`.
- [ ] **Keyboard shortcut customization** — Allow remapping shortcuts like `v` (cycle views), `/` (focus search), `Shift+T` (quick-add todos) via `.minder.json`. Future follow-on to the view-modes feature.

## Performance

- [x] **Background git dirty status** — Background batch worker checks repos 3 at a time, dashboard polls for results and shows amber `+N` indicators as they come in.

## Setup Guide

- [x] **Phase 2: Auto-apply setup to managed projects** — Add buttons on the Setup page (or Config/project cards) to apply Option 1 (append CLAUDE.md rules) or Option 2 (write hook scripts) directly to projects managed by Project Minder. Uses `POST /api/config` or a new `/api/setup/[slug]` route.

## Testing

- [x] **Unit tests for `setupApply.ts`** — Cover idempotent apply logic with temp-dir fixtures: initial apply, re-apply (already-present), malformed `settings.local.json`, and partial hook presence/merge behavior.

## Housekeeping

- [x] **Create CHANGELOG.md** — Set up with Keep a Changelog format.
- [x] **Use dropdown menu dep** — `@radix-ui/react-dropdown-menu` now used for project card action menu.
- [x] **Remove `@radix-ui/react-separator`** — Uninstalled.

## Agents & Skills Pages (Phase 2)

- [ ] **Per-agent cost attribution** — re-include sidechain entries in `parser.ts` behind an `includeSidechains` flag. Build `attachAgentCost()` that groups sidechain turns by `parentToolUseID` and sums token costs. Verify `/usage` totals don't shift.
- [ ] **ProjectCard agent/skill badges** — show a small count of project-local agents/skills in the attention signals row (`src/components/ProjectCard.tsx:181-219`).
- [ ] **Frontmatter linting** — skill/agent rows flagged with a lint chip when `name` or `description` is missing/truncated. Inspiration from skillfile spec.
- [ ] **Slash commands indexing** — extend catalog to index `commands/*.md` files (with `allowed-tools` frontmatter) as a third catalog kind, alongside agents and skills.
- [ ] **Per-item detail pages** — dedicated `/agents/[id]` and `/skills/[id]` routes when usage-history graphs / time-series views become valuable.

## Public Repo Hardening (follow-ups to branch protection)

- [ ] **Community files** — Add `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant), `SECURITY.md`, `.github/PULL_REQUEST_TEMPLATE.md`, and `.github/ISSUE_TEMPLATE/` issue forms. Add `CODEOWNERS` listing yourself so GitHub auto-requests your review on external PRs.
- [ ] **Signed commits** — Set up GPG or SSH commit signing on every machine you develop from, then enable "Require signed commits" in the `main-protection` ruleset.
- [ ] **CodeQL scanning** — Add `.github/workflows/codeql.yml` using `github/codeql-action`. Once it's run once, enable "Require code scanning results" in the ruleset.
- [ ] **Release automation** — Tag-based GitHub Release workflow: on `v*` tag push, run CI, then create a release with auto-generated notes from squashed PR titles.
- [ ] Support running the /insights command in Claude, then display the generated output file (~/.claude/usage-data/report.html) for the user to review. Let the user schedule running /insights to update the report.
- [ ] Support running the /insights command in Claude, then display the generated output file (~/.claude/usage-data/report.html) for the user to review. Let the user schedule running /insights to update the report.

## Config Surfacing — Follow-ups

- [ ] **Template-builder MVP** — cross-project dedupe of hook tuples / MCP server entries / workflow jobs; "copy this unit to project X" action on `/config` rows. Each scanner already retains `sourcePath` + per-unit identifiers, so this is mostly UI + a `POST /api/claude-config/apply` route.
- [ ] **CI badge → /config deep link** — clicking the dashboard `CI` chip should navigate to `/config?type=cicd&project=<slug>` (currently the page ignores URL params; add `useSearchParams` wiring).
- [ ] **`local` ProvenanceBadge variant** — surface `.claude/settings.local.json`-sourced hooks distinctly from `.claude/settings.json`-sourced ones in the cross-project hooks list (currently both show as "project: slug").
- [ ] **Plugin-bundled hooks/MCP** — plugins can ship their own `hooks/hooks.json` and `.mcp.json` under `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. Surfacing these would require iterating `loadInstalledPlugins()` and parsing each plugin's bundled config files; deferred because the signal is weaker than user-level + project-local config.
