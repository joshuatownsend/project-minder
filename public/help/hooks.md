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

Plugins can also ship their own hooks via `<installPath>/hooks/hooks.json`; these surface with a **plugin** provenance badge and are read-only (they cannot be modified from the dashboard).

Click a scope card to filter the list to that scope.

## Row anatomy

Each row shows:
- **Event chip** — the hook trigger (e.g. `PreToolUse`, `PostToolUse`, `SessionStart`)
- **Matcher** — the tool or event pattern (e.g. `Edit|Write`)
- **Command preview** — the first 60 characters of the command
- **local** badge — shown when the hook lives in `settings.local.json`; copying it via Template Mode auto-promotes it to `settings.json` (project-shared)
- **Source badge** — project name (links to the project detail page) or "user" for global hooks
- **↗ apply** button — appears for project-scope hooks (including local-scope) and user-scope hooks; copies the hook definition to another project
- **disable / enable** button — appears for `user` and `local` scope rows; removes the entry from `settings.json` / `settings.local.json` and stashes the original in `~/.claude/.minder/disabled-hooks.json` so re-enable restores byte-equal at the original position
- **edit settings.json** chip — appears on `project` scope rows. Project-shared hooks live in a git-tracked file, so the dashboard intentionally refuses to mutate them. Claude Code has no `disabledHooks` runtime affordance (hooks are additive — `settings.local.json` cannot shadow them), so the only way to disable a project-shared hook is to edit `.claude/settings.json` directly

## Disabled stash

When you disable a `user` or `local` hook, the entry moves to a "Disabled (N)" section beneath the active rows. Click **enable** on a stashed entry to re-insert it at its original event index and matcher-group index (clamped if the surrounding tree has shifted). The stash file is `~/.claude/.minder/disabled-hooks.json`; it survives Claude Code restarts.

## The `/config` Hooks tab

The `/config?type=hooks` tab on the Config page mirrors the toggle behavior above for parity. The top-level `/hooks` page shows the full cross-project view with virtualized scrolling; the `/config` view is non-virtualized and adds scope + effective-state badges + the `↗ apply` button for template mode.

## Filtering

| Control | Effect |
|---|---|
| Search | Matches event, matcher, command text, project name (debounced 300ms) |
| Source dropdown | Filter to `project`, `local`, or `user` scope |
| Sort | By event name (A–Z) or by project name |

## Background activity (T2.3)

The **/background** page aggregates `background_tasks` and `session_crons` arrays emitted by Stop / SubagentStop hook events as of Claude Code v2.1.145. Use it to see what long-running shell commands or scheduled tasks are pending across your portfolio.

**Data source.** When Claude Code finishes a turn (Stop) or a subagent completes (SubagentStop), the hook payload includes the current set of background tasks and session crons. Project Minder's hook receiver parses these arrays into the in-memory ring buffer keyed by project slug; the `/background` page reads from there.

**Freshness rule.** The aggregator only considers Stop / SubagentStop events received in the last 5 minutes. Older events are ignored on read even if they're the only data we have, so the page never claims something is "current" when its last signal was hours ago. The underlying ring buffer is count-capped at 50 events per project and is not time-evicted at write time, but for the purposes of this surface the older entries effectively don't exist.

**Snapshot semantics.** Each Stop hook carries a *snapshot* of background tasks and crons at that moment. An explicit `background_tasks: []` on the latest Stop is treated as authoritative — a task finishing clears the surface, it doesn't fall back to an older non-empty payload. Pre-v2.1.145 Stops that omit both keys entirely are treated as "no info" and skipped, so they don't shadow a prior payload that did carry data.

**Lies-by-omission caveat.** A long-running background task whose session hasn't fired a Stop event in the last 5 minutes won't appear here, even if the underlying OS process is still running. SQLite-backed retention is a planned follow-up.

**Field shape.** The inner shape of each `background_tasks` / `session_crons` entry isn't published in the public Claude Code docs as of v2.1.150, so the page renders whatever fields the payload carries via defensive runtime narrowing — every own-key + stringified value. If Claude Code adds, renames, or drops fields, the page keeps working (no schema break).
