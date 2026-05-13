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

### Navigation & Power-User UX
- **Command palette** — `Ctrl+K` (⌘K) opens a global search overlay reachable from any page. Fuzzy-searches all nav routes, scanned projects, recent sessions, and indexed agents. Arrow-key navigation, Enter to select, Escape to close. Recent selections persist in `localStorage` (last 10). Live pulse counts on Sessions/Inbox/Decisions palette items
- **Configurable keyboard shortcuts** — every default shortcut (`/` search, `Shift+T` quick-add, `v` cycle view, `r` rescan, `?` help, `Ctrl+K` palette) can be remapped in **Settings → Appearance**. Click Edit on any action, press your preferred key combo, click Save. Full conflict detection — the validator rejects combos that would collide with any other action's current binding

### Dashboard & Scanning
- Auto-scans one or more directories (e.g. `~/dev/*`) and renders every project as a card
- **Three view modes** — full cards, compact cards, or sparkline list with 14-day Claude-session activity bars per row (`v` to cycle)
- **Project pinning** — pin frequently-touched projects to the top of every view; pinned rows show a subtle teal tint
- Background git dirty-status checks — amber `+N` indicators appear as results arrive
- Search, filter by status, and sort across all projects (default sort: most-recent Claude session)
- Per-project status labels (active, paused, archived); one-click archive with toast "Undo" action
- Port overrides + per-slug dev-port detection
- CI badge on cards when GitHub workflows are present (deep-links into `/config`)
- 5-minute in-memory scan cache; force-rescan anytime from the UI (keyboard shortcut `r`)

### Claude Code Integration
- **System Status page** — `/status` shows a live cross-project view of every recent Claude Code session in four buckets: Needs Approval, Working, Waiting for You, and Other/Stale. Polls every 3 seconds. Worktree sessions appear labeled by branch. The nav badge shows the pending-approval count.
- **Agent Observatory** (`/agent-view`) — real-time operational view of all running Claude Code sessions across every project, rendered as a six-column Kanban: Needs Input / Working / Idle / Completed / Failed / Stopped. Three data sources merge in priority order: the Claude daemon roster (`~/.claude/daemon/roster.json`), the hook event ring (when Live Activity hooks are installed), and JSONL tail inference as a fallback. SSE transport pushes snapshots on every JSONL append and hook event; auto-reconnect with exponential backoff; polling fallback after 2 failures.
  - **Peek panel** — click any card to open a drawer with three tabs: **Hooks** (last 30 hook events), **Sub-agents** (parent→child orchestration tree built from JSONL replay, with catalog emoji + color cross-references linking to `/agents`), and **Insights** (★ Insight blocks read live from the session JSONL before they sync to INSIGHTS.md).
  - **Card chips** — each Kanban card shows cost estimate, context-fill bar (amber >50%, red >85%), an "⚠ tool err" badge when the latest tool call failed within 2 minutes, and a `+N` sub-agents chip when child agents are running.
  - **Daily spend banner** — shows today's total cost, a progress bar toward the configured daily cap, and a burn-rate projection. Turns amber at 70% of cap, red at 90%. Budget alerts fire as OS notifications when a session approaches or exceeds its session budget.
  - **Spending limits** — configure subscription tier (`pro` / `max5x` / `max20x` / `api`) or explicit daily/session USD caps in **Settings → Cost**. Cards pulse amber/red as spend approaches the limit.
  - **Freshness clock** — toolbar shows "Updated Xs ago" and turns amber after 30s of stream silence.
  - **Near-instant discovery** — new sessions appear within ~200ms via a filesystem watcher on `~/.claude/projects/`; no need to wait for the next poll cycle.
- **Memory Observatory** — browses Claude Code's auto-memory files (`~/.claude/projects/<encoded>/memory/`) in a two-panel view with YAML frontmatter type badges (user / feedback / project / reference), inline editor, and a suite of health signals:
  - **Read telemetry** — tracks how often Claude Code actually opens each file; stamps `Read N× · <relative time>` on every row. An `Unread (30d)` filter narrows to files Claude hasn't touched in 30+ days.
  - **Semantic freshness** — scans prose for source-file references and flags any that no longer resolve on disk. The stale chip composes broken `@imports`, broken prose refs, and file age into a single tooltip.
  - **MEMORY.md index health** — parses the always-loaded `MEMORY.md` index and reports orphan files, dangling links, and line count vs the 200-line cap (amber ≥80%, red ≥95%).
  - **Budget chips** — banner shows total bytes across all memory files vs a 32 KB soft budget; per-row size chip appears only for files exceeding 4 KB.
  - **Memory seed generator** at `/memory/seed` — generates five typed memory files (role, workstyle, repos, dev environment, per-project context) from data Project Minder already scans. Shows an inline LCS diff when a candidate conflicts with an existing file.
  - **Memory triage** at `/memory/triage` — recommends which files to archive or delete based on read frequency, age, broken refs, and MEMORY.md orphan status. Archive moves files to an `archive/` subdirectory; soft-delete sends them to a 30-day `.trash/` window. `Keep 7d/30d/90d` suppresses false-positive rows.
- **Live session status** — dashboard cards show a green "coding" or amber "waiting on you" badge when a Claude session is active; status is inferred from the JSONL tail and refreshes automatically every 15 seconds
- **Sessions browser** — browse every Claude Code session with full-text content search via SQLite FTS5 (matches message body, not just metadata), duration, token counts, and highlighted match snippets; auto-refreshes without a manual reload. A small **FTS** badge indicates when the indexed backend is active. Sessions are grouped by slug — a "continued" badge links each session back to its predecessor in a `--resume`/`--continue` chain.
- **Insights Report viewer** — `/insights-report` renders `~/.claude/usage-data/report.html` (generated by `claude /insights`) inline in a sandboxed iframe. Server-side sanitization strips scripts and inline event handlers before delivery. Empty-state shows the exact command to run when the file is missing.

#### Session quality chips
Each session row in the browser surfaces up to five chips derived from the SQLite index:
- **`NN% cache`** — cache hit ratio; green ≥70%, amber <50%
- **`compaction loop`** (red) — consecutive turns with <10% input variance and >75% context fill
- **`tool fail streak`** (red) — 5+ consecutive turns where >50% of tool results errored
- **`resume anomaly`** (amber) — post-compaction output token spike >10× pre-boundary median; also flags CLI 2.1.69–2.1.89 prompt-cache bug
- **`thinking`** (muted) — session contains at least one extended thinking block

#### Session detail tabs

- **Timeline** — chronological events with fenced code block and inline `code` rendering. **Turn-duration badges** appear on assistant events (e.g. `2.3s`, `4m12s`). **Thinking blocks** are collapsible; content is fetched on-demand from the JSONL at the recorded byte offset — works under the default SQLite mode without storing large blobs in the DB. **Replay scrubber** — a range slider above the event list scrubs through the session chronologically, hiding later events to show the state at any point in time. **Retry cycle highlights** — Edit/Write → Bash → re-Edit patterns are detected and highlighted with an amber left border; the scrubber bar shows a retry-cycle count badge.
- **Tools / Files / Subagents** — tool usage chart, file operations table, subagent cards with verb-derived category chips (`fix` / `find` / `research` / `check` / `create`)
- **Handoff** — mechanical extraction of files modified, git commits, and key commands from the session. When the session was auto-compacted, a **Compaction Fidelity** card scores how much of the mechanical data appears in the LLM-generated compaction summary (flags <60% as low-fidelity). **Generate handoff doc** opens a modal with four verbosity levels (Minimal → Full) plus Copy and Download buttons.
- **Diagnosis** — 10-category quality analysis computed on demand from the JSONL: cache TTL expiry, cache thrash, context bloat, near-compaction, compaction loop, tool failure streak, high idle, context-dominated, resume anomaly, and buggy CLI version. Header strip shows outcome (completed / partial / abandoned / stuck), cache hit %, cache rebuild waste in dollars, peak fill, and total idle. Top-advice block ranks the three highest-impact fixes.
- **Feedback** — when Claude Code has recorded a per-session qualitative self-rating in `~/.claude/usage-data/facets/`, shows underlying goal, outcome, helpfulness, satisfaction, friction, and a brief summary.

#### Project-level session analytics

- **Efficiency tab** — per-project A–F waste grade from five detectors: junk-directory reads, duplicate reads, unused MCP servers, ghost capabilities (indexed agents/skills never invoked), and low read/edit ratio. Yield analysis classifies sessions as Productive / Reverted / Abandoned by overlapping session intervals with the git commit log. Shows yield rate and $/shipped-commit. Self-correction rate (per model) surfaced from phrase detection across all assistant turns.
- **Hot Files tab** — edit-frequency ranking across all sessions (total edits, session count, last-edit timestamp) plus a co-edit coupling table with Jaccard similarity scores.
- **Patterns tab** — recurring Bash binary sequences (n-grams of length 2–4) detected across sessions; suggests kebab-case skill names and fuzzy-matches against the skills catalog.

- **Session recaps** — surfaces `/recap` summaries as the primary session label with an amber badge
- **Insights extraction** — scrapes `★ Insight` blocks from conversation history into per-project `INSIGHTS.md` files; cross-project browser with full-text search
- **Token cost analytics** — `/usage` page with time-period filters, per-model/project/category breakdowns, daily cost trend chart, self-correction rate per model, CSV/JSON export; worktree sessions merged into their parent project in the By Project chart. Includes a **Feedback aggregate** section (outcome/helpfulness/satisfaction/friction distributions across all sessions with facets data) and a collapsible **CLI Version History** table (session counts per version, `buggy` badge for versions 2.1.69–2.1.89).

### Multi-Platform Coding Agent Support
Project Minder indexes sessions from multiple AI coding tools in a single unified view:

- **Claude Code** — primary adapter; reads `~/.claude/projects/**/*.jsonl`. All analytics, quality chips, diagnosis, and handoff features apply.
- **Codex CLI** — reads `~/.codex/sessions/` and `~/.codex/archived_sessions/`. Token deltas computed from per-turn `last_token_usage` with delta-from-total fallback. Project slugs derived from `cwd` in session metadata, so Codex sessions correlate with the right project in analytics.
- **Gemini CLI** — reads `~/.gemini/tmp/<project>/chats/session-*.json`. Project paths resolved from `~/.gemini/projects.json` or `.project_root` fallback files. Per-turn token deltas from `tokens.{input, output, cached}`. `GEMINI_HOME` env var overrides the default path.

Adapters are enabled/disabled in **Settings → Adapters**. The `/usage` page's **By Source** breakdown shows cost attribution per tool. The sessions browser's source filter and source badges make multi-tool sessions easy to distinguish.

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
- **Curated library** — `/library` page with 16 production-ready items (5 commands, 7 skills, 4 agents) you can apply to any project in one click. Filter by kind, search by name/description/tag, preview before applying
- **New-project wizard** — `/new-project` 4-step wizard: name + folder → stack (TypeScript / Python / Go / Rust) → library item selection with stack-based presets → confirm. Bootstraps the directory, runs `git init`, and applies selected library items

### Hooks, Plugins, MCP & CI/CD
- **`/config` cross-project catalog** — 5-tab shell surfacing project Hooks, Plugins, MCP servers, GitHub Actions workflows, dependabot, and Vercel/Railway/Fly/Render/Netlify/Heroku host config across every scanned project. Per-row provenance shows whether a hook came from `.claude/settings.json` (project-shared) or `.claude/settings.local.json` (local-only) — copying a `local` hook via Template Mode auto-promotes it to project-shared
- **Project Config tab** — appears on a project detail page when project-local hooks, `.mcp.json`, or CI/CD config is present (no user-level repetition; user-scope items live on `/config`)
- **Plugin-bundled hooks** — plugins that ship a `hooks/hooks.json` manifest surface their entries automatically with a `plugin` provenance badge; read-only (edits go to the plugin source)
- **CI workflow parsing** — workflows expose normalized `on:` triggers, schedule crons, jobs (id, name, runs-on), and deduped action `uses:` references; vercel.json crons extracted; dependabot updates emitted per-ecosystem
- **MCP Security Scanner** — static-surface analysis of every MCP server's config: 8-pass deobfuscation pipeline (zero-width chars, tag injection, base64 blocks, Bidi controls, etc.) → 58 pattern rules across 13 threat categories (prompt injection, capability hijack, data exfil, tool poisoning, and more) → SHA-256 tool-description fingerprinting for rug-pull detection. Findings surface in the **Config → MCP** tab as severity chips (`crit` / `high` / `med` / `low`) with an expandable findings list and a manual rescan button. Runs automatically alongside `POST /api/scan`

### Mission Control
- **Kanban board** — `/kanban` unifies Claude Code sessions and dispatcher tasks in a 5-column board (Working / Waiting / Idle / Done / Error). Three view modes switchable from the toolbar:
  - **Board** — classic kanban with blocked/waiting badges
  - **DAG** — dependency graph with Sugiyama-style layered layout, D3 SVG edges, and cubic Bezier connectors; nodes colored by status
  - **Gantt** — `d3.scaleTime()` horizontal bars with dependency arrows; placeholder bars for pending tasks
- **Task dispatcher** — compose one-shot or interactive tasks via the Task Composer modal (`Shift+T`). Dispatched tasks run as child `claude -p` processes; interactive tasks support `DECISION:` markers that surface in the Decisions panel for approval
- **Task dependencies** — create dependency edges between tasks (Task Composer checkbox list or REST API). The dispatcher enforces the graph — a task stays pending until all its blockers reach `done`. Cycle prevention at insert time via DFS
- **Multi-agent swarms** — `SwarmComposer` modal (entry from task board or project card dropdown): name, project path, mode (shared / worktree), 2–8 member task definitions, optional coordinator. Worktree mode runs each member in a separate `git worktree`. Coordinator task unblocks when all members reach any terminal state and receives member output summaries injected into its description. `/swarms` list and `/swarms/[id]` detail page (polls every 5 s while running)
- **Emergency stop** — kills all dispatcher child processes; manually-started Claude Code sessions survive

### Project Management
- **TODO tracking** — reads each project's `TODO.md`; add items inline or via a cross-project Quick Add modal (`Shift+T`)
- **Manual Steps tracker** — surfaces `MANUAL_STEPS.md` entries across all projects; interactive checkboxes toggle steps on disk; file watcher fires toast + OS notifications when Claude adds new steps mid-session
- **Worktree overlay** — TODOs, Manual Steps, and Insights from active Claude Code worktrees appear in collapsible sections on detail pages; card badges aggregate main + worktree counts
- **GSD Planning tab** — when a project has a `.planning/` directory, a Planning tab appears on the project detail page. Reads `PROJECT.md`, `ROADMAP.md`, `STATE.md` (YAML frontmatter via js-yaml), and `phases/*.md`. Per-phase cost attribution queries the SQLite index for sessions in the phase window — shows actual spend per phase when `startedAt`/`endedAt` are set in `STATE.md`

### Observability & Stats
- **Stats dashboard** — portfolio-wide overview: tech stack distribution, project health, Claude Code usage (tokens, tools, models)
- **Usage dashboard** — 13-category activity classification, one-shot success rate detection, shell command and MCP server frequency breakdowns, self-correction rate per model, feedback aggregate, and CLI version history
- **Shareable stats image** — `GET /api/share` returns a pure-SVG stats card (1200×800) with KPI row, 24-hour activity strip, top-5 projects bar chart, and by-model stacked bar. **Share** button on `/usage` opens a modal with period/theme toggles, Copy URL, and Download SVG. No canvas or headless browser required
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
npm run setup-hooks   # installs the pre-commit hook (typecheck + test)
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
| `hidden` | `string[]` | Project slugs excluded entirely from the scan (Setup-only power feature). |
| `portOverrides` | `Record<string, number>` | Override the detected dev port for a project. |
| `viewMode` | `"full" \| "compact" \| "list"` | Default dashboard view. |
| `pinnedSlugs` | `string[]` | Project slugs pinned to the top of every view. |
| `defaultSort` | `"activity" \| "name" \| "claude"` | Initial sort order. |
| `defaultStatusFilter` | `"all" \| "active" \| "paused" \| "archived"` | Initial status filter. |
| `keyboardShortcuts` | `Record<string, string>` | Per-action shortcut overrides (e.g. `{"focus-search": "s"}`). Managed via Settings → Appearance. |
| `enabledAdapters` | `string[]` | Active coding-agent adapters. Defaults to `["claude"]`. Add `"codex"` or `"gemini"` to enable those sources. |
| `templates` | `{ defaultConflictPolicy?, lastUsedSlug? }` | Apply Template modal preferences. |
| `subscriptionTier` | `"pro" \| "max5x" \| "max20x" \| "api"` | Subscription plan used to derive the daily spend cap for Agent Observatory budget alerts. |
| `budgets` | `{ sessionUsd?: number; dailyUsd?: number }` | Explicit session and daily USD spend caps. Agent Observatory cards pulse amber/red as spend approaches the limit. |

### Environment overrides

Set in `.env.local` (gitignored) for persistent per-machine overrides:

| Variable | Default | Effect |
|---|---|---|
| `MINDER_USE_DB` | on | `=0` disables the SQLite index (session pages fall back to direct JSONL parsing). |
| `MINDER_INDEXER` | on | `=0` suppresses the chokidar watcher (no automatic index updates). |
| `MINDER_INDEXER_WORKER` | off | `=1` hosts the watcher in a `worker_thread` for crash isolation. |
| `GEMINI_HOME` | `~/.gemini` | Override the Gemini CLI data directory. |

---

## How It Works

Project Minder is a Next.js app that runs entirely on your local machine — no cloud sync, no telemetry. Two storage tiers cooperate:

- **Filesystem as source of truth.** Project metadata, TODOs, manual steps, insights, and Claude Code config all stay where they already live (your project directories, `~/.claude/`, `MANUAL_STEPS.md` in your repos). Edit any of them in your editor and the dashboard reflects the change.
- **Local SQLite index** at `~/.minder/index.db` (schema v12). A chokidar watcher tails `~/.claude/projects/**/*.jsonl` and incrementally updates derived tables (sessions, turns, tool uses, file edits, daily costs, plus an FTS5 prompt-search table, MCP scan runs, MCP scan findings, MCP tool fingerprints for rug-pull detection, and task dependency edges). Derived columns include per-session quality signals (cache hit ratio, compaction loop, tool failure streak, context fill, resume anomaly, thinking blocks, CLI version) and per-turn data (duration, byte offset for on-demand thinking content). The dashboard reads aggregates directly from indexed columns instead of re-parsing 1+ GB of JSONL on every request. The index is purely derived — delete it and it rebuilds on next boot.

On each dashboard load Project Minder scans your configured directories in parallel batches, running scanner modules per project (package.json, git, Claude sessions, TODOs, manual steps, insights, hooks, MCP servers, CI/CD config, and more). Project-scan results are cached in memory for 5 minutes; the SQLite index is kept fresh in real time by the watcher. A background worker checks git dirty status in rolling batches of 3 repos.

The process manager spawns dev servers as child processes using project-local binaries and stores the last 200 lines of output per process. On Windows it uses `taskkill /F /T` for clean process-tree teardown; on macOS/Linux it sends `SIGTERM` to the process group.

### Power tools

- **Read-only `/api/sql`** — query the local SQLite index for ad-hoc analytics. `GET /api/sql?sql=…` or `POST /api/sql {sql, params?}`. SELECT/WITH only, hard 10 000-row cap, both regex pre-gate and `stmt.readonly` enforcement.
- **Worker mode (opt-in)** — set `MINDER_INDEXER_WORKER=1` to host the watcher in a Node `worker_thread`. Server boots immediately while the initial reconcile (~20 s for 3k JSONL files post-throughput-tuning) runs in the background. If SQLite or chokidar throws fatally, the dashboard falls back to the in-process watcher automatically.

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
