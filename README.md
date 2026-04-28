# Project Minder

> A local-only dev dashboard that auto-scans your projects and surfaces the context you need — git status, Claude Code sessions, TODOs, costs, and more — without leaving your browser.

![Node](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Stack](https://img.shields.io/badge/stack-Next.js%2016%20%2B%20TypeScript-black)

---

![Dashboard](docs/images/dashboard.png)

---
Check out [https://joshuatownsend.github.io/project-minder/](https://joshuatownsend.github.io/project-minder/) for more info and interface screenshots!
---
## Features

### Dashboard & Scanning
- Auto-scans one or more directories (e.g. `~/dev/*`) and renders every project as a card
- Background git dirty-status checks — amber `+N` indicators appear as results arrive
- Search, filter by status, and sort across all projects
- Per-project status labels (active, paused, archived), hide/unhide, and port overrides
- 5-minute in-memory scan cache; force-rescan anytime from the UI

### Claude Code Integration
- **System Status page** — `/status` shows a live cross-project view of every recent Claude Code session in four buckets: Needs Approval, Working, Waiting for You, and Other/Stale. Polls every 3 seconds. Worktree sessions appear labeled by branch. The nav badge shows the pending-approval count. Classification uses a 4-state heuristic: stalled mtime on write-type tools → Approval; active tools → Working; clean `end_turn` → Waiting for You; stale >10 min → Other/Stale.
- **Memory tab** — each project detail page has a Memory tab that browses Claude Code's auto-memory files (`~/.claude/projects/<encoded>/memory/`). `MEMORY.md` renders as a top-level overview; other files are listed in a two-panel browser with YAML frontmatter type badges (user / feedback / project / reference) and on-demand content rendering.
- **Live session status** — dashboard cards show a green "coding" or amber "waiting on you" badge when a Claude session is active; status is inferred from the JSONL tail (tool_use/tool_result pairing + file mtime) and refreshes automatically every 15 seconds
- **Sessions browser** — browse every Claude Code session with full-text content search (matches message body, not just metadata), duration, token counts, and highlighted match snippets; auto-refreshes without a manual reload
- **Session detail** — full timeline with fenced code block and inline `code` rendering, tool usage, file operations, and subagent tracking per session
- **Session recaps** — surfaces `/recap` summaries as the primary session label with an amber badge
- **Insights extraction** — scrapes `★ Insight` blocks from conversation history into per-project `INSIGHTS.md` files; cross-project browser with full-text search
- **Token cost analytics** — `/usage` page with time-period filters, per-model/project/category breakdowns, daily cost trend chart, and CSV/JSON export; worktree sessions are merged into their parent project in the By Project chart

### Agents, Skills & Plugins
- **Agents catalog** — `/agents` indexes every Claude Code agent persona from `~/.claude/agents/`, `~/.agents/agents/`, installed plugins, and per-project `.claude/agents/`; shows usage counts, last-invoked timestamps, and source provenance
- **Skills catalog** — `/skills` indexes all slash-command skills from the same source tree; handles both bundled (`SKILL.md`-in-dir) and standalone (`.md`) layouts
- **Commands catalog** — `/commands` indexes every Claude Code slash command from user, plugin, and project scopes; expand any row to see `allowed-tools`, `argument-hint`, body excerpt, and a one-click action to copy the command into another project
- **Provenance badges** — each row carries a marketplace badge (name · version · commit SHA) or a `local` / `project:<slug>` tag showing exactly where the item came from
- **Update detection** — an amber dot appears when an upstream update is available; checks run in the background via `git ls-remote` (marketplace plugins) and the GitHub tree API (lockfile-installed skills) on a 24-hour TTL
- **Per-row actions** — expand any row to see tools, model, body excerpt, recent sessions, and actions: open source ↗, show in folder, copy URL / SHA / path, re-check
- **Per-project tabs** — each project detail page has Agents and Skills tabs split into *Available* (installed) and *Invoked here* (used in that repo's sessions)
- **Search, filter & sort** — search by name/description/plugin; filter by source (user / plugin / project) or updates-only; sort by most invoked, recently used, or name

### Template Mode
- **One-click cross-project copy** — every project-scoped row in `/agents`, `/skills`, `/commands`, and `/config` (Hooks · MCP) carries a `↗ copy to project` action. Pick a target project, choose a conflict policy (`skip` / `overwrite` / `merge` / `rename`), preview the diff via dry-run, then apply atomically with cache invalidation
- **Idempotent hook copy** — hook identity is `event + matcher + sha256(invocation)` so re-applying never produces duplicates. Referenced scripts at `.claude/hooks/<file>` come along automatically; absolute paths into the source project are rejected
- **Local→project promotion** — hooks sourced from `.claude/settings.local.json` write to project-shared `settings.json` at the target with a warning so the change is transparent
- **MCP env-keys-only** — env *values* are never copied. The target's `.mcp.json` receives empty-string placeholders for every env key with a warning listing what to fill in
- **Template projects** — bundle a curated set of agents, skills, commands, hooks, MCP servers, plugin enables, and GitHub Actions workflows into a manifest at `<devRoot>/.minder/templates/<slug>/`. Two flavors: **live** (manifest points at a source project — edits flow through) or **snapshot** (frozen copy at promotion time)
- **Authoring** — the project card three-dot menu has a **Mark as template…** entry that opens a unit picker (with installed/not-installed badges for plugins). Save a live template as a snapshot from its detail page when ready
- **Apply Template modal** — target = existing project or a not-yet-existing path under devRoot (Project Minder runs `mkdir` + `git init`, no language scaffolding). Default conflict policy plus expandable per-unit overrides; aggregate dry-run preview with per-unit diffs and warnings before commit
- **Plugin "requires install" UX** — applying a plugin enable when the plugin isn't installed at `~/.claude/plugins/` writes the flag anyway and surfaces a copy-pastable `/plugin install <name>@<marketplace>` hint; the flag activates automatically once the plugin lands
- **Path safety** — every target is `path.resolve`d into one of the configured dev roots; `<root>/.minder/` is reserved; path-traversal in workflow keys is rejected

### Project Management
- **TODO tracking** — reads each project's `TODO.md`; add items inline or via a cross-project Quick Add modal (Shift+T)
- **Manual Steps tracker** — surfaces `MANUAL_STEPS.md` entries across all projects; interactive checkboxes toggle steps on disk; file watcher fires toast + OS notifications when Claude adds new steps mid-session
- **Worktree overlay** — TODOs, Manual Steps, and Insights from active Claude Code worktrees appear in collapsible sections on detail pages; card badges aggregate main + worktree counts

### Observability & Stats
- **Stats dashboard** — portfolio-wide overview: tech stack distribution, project health, Claude Code usage (tokens, tools, models)
- **Usage dashboard** — 13-category activity classification, one-shot success rate detection, shell command and MCP server frequency breakdowns
- **Dev server control** — start, stop, and restart managed dev servers from the UI; view live stdout/stderr output

### Setup Tools
- **Setup guide** — `/setup` page with copy-paste CLAUDE.md instruction blocks and optional Claude Code `PreToolUse` hooks
- **Auto-apply** — apply setup steps directly to any managed project from the UI; idempotent (existing blocks are skipped, files backed up to `.minder-bak`)

---

## Quick Start

**Prerequisites:** Node.js ≥ 20.19 — runs on macOS, Linux, and Windows

```bash
git clone https://github.com/joshuatownsend/project-minder.git
cd project-minder
npm install
```

Configure your scan root(s) in `.minder.json` in the Project Minder repo root — the same directory where you run `npm run dev` (create it if it doesn't exist):

```json
{
  "devRoots": ["/home/you/dev"]
}
```

On Windows use `C:\\dev` (or whatever your dev root is).

Then start the dev server:

```bash
npm run dev
# Open http://localhost:4100
```

---

## Configuration

All settings live in `.minder.json` at the repo root. The in-app **Config page** (`/config`) provides a full UI for most of these.

| Key | Type | Description |
|-----|------|-------------|
| `devRoots` | `string[]` | Directories to scan. First entry is the primary root. |
| `devRoot` | `string` | Legacy single-root fallback. Kept in sync automatically. |
| `statuses` | `Record<string, "active" \| "paused" \| "archived">` | Per-project status labels. |
| `hidden` | `string[]` | Project slugs hidden from the dashboard. |
| `portOverrides` | `Record<string, number>` | Override the detected dev port for a project. |

---

## How It Works

Project Minder is a Next.js app that runs entirely on your local machine — no database, no cloud sync. On each dashboard load it scans your configured directories in parallel batches, running 9 scanner modules per project (package.json, git, Claude sessions, TODOs, manual steps, insights, and more). Results are cached in memory for 5 minutes. A background worker checks git dirty status in rolling batches of 3 repos, and the dashboard polls for results as they arrive.

The process manager spawns dev servers as child processes using project-local binaries and stores the last 200 lines of output per process. On Windows it uses `taskkill /F /T` for clean process-tree teardown; on macOS/Linux it sends `SIGTERM` to the process group.

---

## Inspired By

- [CodeBurn](https://github.com/AgentSeal/codeburn) — token cost analytics design
- [Sniffly](https://github.com/chiphuyen/sniffly) — stats dashboard concept
- [claude-code-karma](https://github.com/JayantDevkar/claude-code-karma) — sessions browser concept
- [c9watch](https://github.com/minchenlee/c9watch) — live session status monitoring concept
- [raphi011's insights gist](https://gist.github.com/raphi011/dc96edf80b0db8584527fefc6a3b4bd0) — insights extraction concept

---

## License

MIT © Josh Townsend
