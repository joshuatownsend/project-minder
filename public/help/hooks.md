# Hooks

The Hooks browser shows every hook entry across all your projects and your user-scope Claude config, organized by source scope.

## Coverage matrix

The four stat cards at the top summarise coverage at a glance:

| Card | What it counts |
|---|---|
| **Project** | Hooks in `.claude/settings.json` inside a project directory |
| **Local** | Hooks in `.claude/settings.local.json` (per-machine, not shared in git) |
| **User** | Hooks in `~/.claude.json` or `~/.claude/settings.json` (apply everywhere) |
| **Events** | Number of distinct event types across all hooks |

Click a scope card to filter the list to that scope.

## Row anatomy

Each row shows:
- **Event chip** — the hook trigger (e.g. `PreToolUse`, `PostToolUse`, `SessionStart`)
- **Matcher** — the tool or event pattern (e.g. `Edit|Write`)
- **Command preview** — the first 60 characters of the command
- **local** badge — shown when the hook lives in `settings.local.json`; copying it via Template Mode auto-promotes it to `settings.json` (project-shared)
- **Source badge** — project name (links to the project detail page) or "user" for global hooks
- **↗ apply** button — appears for project-scope hooks (including local-scope) and user-scope hooks; copies the hook definition to another project

## The `/config` Hooks tab

The `/config?type=hooks` tab on the Config page continues to exist for per-project deep-linking (e.g., "View hooks for this project"). The top-level `/hooks` page shows the full cross-project view.

## Filtering

| Control | Effect |
|---|---|
| Search | Matches event, matcher, command text, project name (debounced 300ms) |
| Source dropdown | Filter to `project`, `local`, or `user` scope |
| Sort | By event name (A–Z) or by project name |
