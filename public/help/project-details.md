# Project Detail Page

Click any project card on the dashboard to open its detail page. The detail page has a header section and four tabs.

## Header

At the top you'll find:

- **Back button** — returns to the dashboard
- **Project name** and full file path
- **Tech stack badges** — detected framework, ORM, styling, etc.
- **Status selector** — click **Active**, **Paused**, or **Archived** to change the project's status
- **Quick actions:**
  - **VS Code** — opens the project folder in Visual Studio Code
  - **Terminal** — opens Windows Terminal in the project directory

## Overview Tab

The default tab shows a structured summary of the project.

### Dev Server Control

Start, stop, and restart the project's dev server directly from the dashboard. See [Dev Servers](dev-servers.md) for details.

### Ports

- **Dev server port** — the port used when starting the dev server (editable — see [Ports](ports.md))
- **Database port** — detected from environment files
- **Docker ports** — service names and host-to-container port mappings from `docker-compose.yml`

### Database

If a database is detected, shows the type (PostgreSQL, MySQL, MongoDB, etc.), host, port, and database name.

### External Services

Lists any external APIs or services detected in the project (e.g., AWS, Firebase, Auth0), shown as badges.

### Git Status

- Current branch name
- Time since last commit
- Last commit message
- Number of uncommitted changes (if any)

### GitHub

When the project's remote is a `github.com` repo and the local `gh` CLI is authenticated, a **GitHub** section shows open PRs, the latest default-branch CI status, last push, and an expandable open-PR list (with a link to the session that opened each PR). See [GitHub Activity](github-activity.md) for details and setup.

### Git Activity

When the project has Claude sessions, the **Git Activity** panel aggregates `git commit` and `git push` calls made across all recorded sessions. It shows:

- **Commits** and **Pushes** — total counts across all sessions
- **Branches** — list of branches Claude worked on, sorted by most-recent session

Data is sourced from Bash/PowerShell tool call arguments in the SQLite index (DB mode) or by re-parsing JSONL files (file-parse fallback). The panel is hidden when no git activity was detected.

## Context Tab

Displays the full contents of the project's `CLAUDE.md` file, if one exists. This is the context file that Claude reads when working on the project.

## TODOs Tab

Shows TODO items parsed from the project's `TODO.md` file:

- A **progress bar** showing completion percentage
- Each item listed with a checkmark (done) or open circle (pending)
- A total count of completed vs. remaining items

Completed or obsolete items are moved out of the active list into a companion
`TODO.archive.md`. Expand the **Archived** disclosure at the bottom of the tab to
review them — it loads the archive on demand and is read-only.

### Adding TODOs

Use the **Add a new TODO...** field at the bottom of the tab to append a new
item to `TODO.md`. The item is written as `- [ ] your text` on a new line at
the end of the file (the file is created automatically if it doesn't exist).

For dumping ideas into many projects at once, use the **Quick Add** button in
the dashboard header (shortcut: **Shift+T**). See [Quick Add TODOs](quick-actions.md#quick-add-todos).

## Worktree Overlays

When a project has active Claude Code worktrees (directories named `project--claude-worktrees-branch` in your dev root), the TODOs, Manual Steps, and Insights tabs will show **worktree sections** below the main content.

- Worktree sections are **collapsed by default** — click to expand
- Each section shows a **branch badge** (e.g., `feature/gitwc`) and item count
- Worktree items are **read-only** — you can view them but not toggle checkboxes or add items
- Items automatically disappear when the worktree branch is merged and the directory is removed
- Dashboard card badges show **aggregated counts** (main + worktree items combined)

## Claude Tab

Shows your Claude session history for this project:

- Total number of sessions
- When the most recent session occurred
- A preview of the first prompt from the latest session

## Efficiency Tab

Appears when the project has Claude sessions. Shows three analytics panels:

- **Waste Optimizer** — grades the project A–F and lists up to 5 findings: junk-directory reads, duplicate reads, unused MCP servers, ghost agent/skill capabilities, and low read/edit ratio. Each finding includes a severity level and actionable detail. A **trend badge** beside the grade shows whether the grade has improved, declined, or stayed stable since the most recent earlier day on which the grade was recorded (`↑ improving` / `↓ declining` / `= stable` / `• new`). Trends populate over time as daily grade snapshots accumulate — a brand-new project, or the first day of tracking, shows **new**. The same movement appears as a small green ↑ / red ↓ arrow next to the grade letter on the dashboard project cards. (Grade snapshots and trends require the SQLite backend; with it disabled the grade still shows, just without a trend.)
- **Session Yield** — classifies sessions as Productive, Reverted, or Abandoned by aligning session intervals with the main-branch commit log. Displays yield rate, total sessions analysed, and cost-per-shipped-commit when session cost data is available.
- **By Work Mode** — colour-coded strip and percentage breakdown of how the project's assistant turns were classified across the four work modes (Exploration, Building, Testing, Other). Matches the per-session strips shown in the Sessions browser.

## Patterns Tab

Appears when the project has Claude sessions. Detects recurring Bash sequences across sessions and surfaces them as candidate workflow automations.

Each pattern shows:

- **Binary sequence** — the ordered list of command-line binaries (e.g., `git` → `npm test` → `git`).
- **Sessions** — how many distinct sessions ran this sequence.
- **Runs** — total occurrences across all sessions.
- **Suggested skill** (or **Matched skill**) — a kebab-case name derived from the binary sequence (e.g., `git-test-commit-flow`). When a skill in your catalog already matches the pattern, the tab shows the existing skill name and its invocation count instead of a suggestion.

Patterns only appear after a sequence recurs in at least **3 sessions**. All-identical sequences (e.g., `git → git → git`) are filtered out as noise. Sequences of length 2, 3, and 4 are detected.

Use the suggestions to decide which workflow automations are worth turning into Claude Code skills.

## Hot Files Tab

Appears when the project has Claude sessions. Shows cross-session file intelligence:

- **Summary strip** — unique files edited, total edit operations, and sessions analysed.
- **Hot Files** — files ranked by total edit count, with a bar chart and per-file breakdown of write / edit / delete operations and the number of sessions that touched each file.
- **File Coupling** — when 4 or more files are co-edited, an **arc diagram** shows pairs of files as quadratic Bezier arcs above a horizontal file axis. Arc thickness scales with co-occurrence count; arc opacity scales with coupling strength. Click a file node to highlight its arcs and dim unrelated ones. With fewer than 4 files, falls back to a bar list.

## Errors Tab

Appears when the project has Claude sessions. Cross-session error analysis across all subagent hierarchy levels:

- **Summary strip** — total sessions, agent nodes, errors, and overall error rate.
- **Errors by hierarchy depth** — bar chart colored red (depth 0) → purple (depth 6+). Depth 0 = direct subagents of the main conversation; higher depths = nested subagents. Hover a bar for depth, error count/total, and rate.
- **Top error-prone agents** — agents that appeared in at least 3 invocations, ranked by error count with a bar showing their rate.
- **Tool error breakdown** — which tools were involved in error turns across all sidechain sessions. Only tools with 2+ occurrences are shown.

When no errors have occurred across any session, the tab shows a success confirmation with the session count.
