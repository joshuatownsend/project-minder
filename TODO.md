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
- [x] **Slash commands indexing** — `walkProjectCommands` / `walkUserCommands` / `walkPluginCommands` ship in `src/lib/indexer/walkCommands.ts`. Apply layer uses them; cross-project browser UI deferred to a future `/commands` page.
- [ ] **Per-item detail pages** — dedicated `/agents/[id]` and `/skills/[id]` routes when usage-history graphs / time-series views become valuable.

## Public Repo Hardening (follow-ups to branch protection)

- [ ] **Community files** — Add `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant), `SECURITY.md`, `.github/PULL_REQUEST_TEMPLATE.md`, and `.github/ISSUE_TEMPLATE/` issue forms. Add `CODEOWNERS` listing yourself so GitHub auto-requests your review on external PRs.
- [ ] **Signed commits** — Set up GPG or SSH commit signing on every machine you develop from, then enable "Require signed commits" in the `main-protection` ruleset.
- [ ] **CodeQL scanning** — Add `.github/workflows/codeql.yml` using `github/codeql-action`. Once it's run once, enable "Require code scanning results" in the ruleset.
- [ ] **Release automation** — Tag-based GitHub Release workflow: on `v*` tag push, run CI, then create a release with auto-generated notes from squashed PR titles.
- [ ] Support running the /insights command in Claude, then display the generated output file (~/.claude/usage-data/report.html) for the user to review. Let the user schedule running /insights to update the report.

## Config Surfacing — Follow-ups

- [x] **Template Mode V1 (was: Template-builder MVP)** — single-unit copy across projects via `POST /api/claude-config/apply`. `↗ copy to project` action lands on `/config` (hooks, MCP), `/agents`, `/skills` rows. Hooks identity is `event + matcher + sha256(invocation)` for idempotent re-apply; MCP env values are never copied. V2 (template projects, new-project bootstrap) tracked separately.

## Template Mode — V2 / V3 follow-ups

- [x] **Template Mode V2 — template projects** — hybrid `kind: "live" | "snapshot"` manifests at `<devRoot>/.minder/templates/<slug>/`. `/templates` page (browser + detail + apply modal), "Mark as template…" on the project card menu, `POST /api/templates/[slug]/apply` orchestrates per-unit dispatch with `dryRun` + aggregate summary. Snapshot bundles mirror a real project's `.claude/` + `.mcp.json` so the apply layer reads either flavor uniformly.
- [x] **Template Mode V2 — new-project bootstrap** — apply with `target.kind: "new"` accepts a not-yet-existing relative path under devRoot, `mkdir`s, optionally runs `git init`, iterates units, then triggers a post-apply scan so the dashboard picks up the new project.
- [ ] **Template Mode V2 — settings-key + plugin-enable apply** — extend the apply layer with `applySettings` (deep-merge with `permissions.allow` concat-and-dedupe semantics) and `applyPlugin` (writes enable-list with "requires install" warning when plugin missing from `~/.claude/plugins/installed_plugins.json`).
- [ ] **Template Mode V2 — bundled-skill UI surface** — bundled skills already work in the V1 apply layer. UI button is on `/skills` rows. Visual confirmation that bundled vs standalone is clearly distinguished in the diff preview.
- [ ] **Template Mode V3 — CI/CD workflow per-job copy** — add `applyWorkflow` that file-replaces `.github/workflows/<name>.yml` (no JSON merge — workflows are file-replace only). UI button on the CI/CD `/config` rows.
- [ ] **Slash-commands `/commands` browser page** — surface `walkProjectCommands` output cross-project, mirroring `/agents` and `/skills`. The Template Mode `↗ copy to project` action ports over with no API changes.
- [ ] **User-scope hook + MCP source support** — V1 only supports project-source for hooks and MCP. Extending the dispatch layer to read from `~/.claude/settings.json` would let users seed a project's settings from their personal config.
- [ ] **CI badge → /config deep link** — clicking the dashboard `CI` chip should navigate to `/config?type=cicd&project=<slug>` (currently the page ignores URL params; add `useSearchParams` wiring).
- [ ] **`local` ProvenanceBadge variant** — surface `.claude/settings.local.json`-sourced hooks distinctly from `.claude/settings.json`-sourced ones in the cross-project hooks list (currently both show as "project: slug").
- [ ] **Plugin-bundled hooks/MCP** — plugins can ship their own `hooks/hooks.json` and `.mcp.json` under `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. Surfacing these would require iterating `loadInstalledPlugins()` and parsing each plugin's bundled config files; deferred because the signal is weaker than user-level + project-local config.
