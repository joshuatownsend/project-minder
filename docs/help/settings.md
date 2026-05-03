# Settings

The Settings page (`/settings`) controls Project Minder's own behavior — what it scans, what it watches, what it surfaces. It complements the **Config** browser, which surfaces *Claude Code's* configuration across all your projects.

## Sections

| Section | Wave | What it controls |
|---------|------|------------------|
| **Features** | 1 | Subsystem on/off toggles. Decide which scanners and watchers run. |
| **Appearance** | 12 | View mode default, theme, keyboard shortcuts. |
| **Cost** | 8 | Currency display, custom pricing rules, schedule mode for quota burndown. |
| **Notifications** | 7 | Web push and Telegram per-event toggles. |
| **Integrations** | 8 | OTEL telemetry setup, Anthropic OAuth for quota fetch, currency API status. |
| **Data & Privacy** | 7 | Config history retention, session distillation defaults, export shortcuts. |
| **Terminal** | 7 | Preferred terminal application for "Resume in terminal." |
| **Auto-title** | 7 | LLM endpoint for session title generation. |

Sections marked with a wave label other than 1 currently render a placeholder. The IA is final on day one — controls fill in as the corresponding wave lands.

## Features section

Two groups of toggles.

### Passive observation
Cheap filesystem reads run on every scan:

- **Scan INSIGHTS.md** — reads `INSIGHTS.md` from each project.
- **Scan TODO.md** — reads `TODO.md` and surfaces pending/completed counts.
- **Scan MANUAL_STEPS.md** — reads `MANUAL_STEPS.md` from each project.
- **Scan Claude history** — joins `~/.claude/history.jsonl` into per-project session counts.
- **Scan Claude worktrees** — discovers `--claude-worktrees-*` directories and overlays their TODO/INSIGHTS/STEPS onto the parent project.
- **Scan docker-compose** — parses `docker-compose.yml` for port mappings.

Disabling any of these takes effect on the **next scan**. Disabled scanners substitute neutral values (empty docker results, undefined todos/insights/manual-steps), so the rest of the dashboard stays consistent.

### Active subsystems
Background work — watchers, ingest, indexers:

- **Manual steps watcher** — background `fs.watch` of `MANUAL_STEPS.md` across all projects (drives the Pulse badge and toasts).
- **Git status cache** — background batched `git status --porcelain` enqueued on each dashboard load.
- **Usage analytics** — cost calc and token aggregation on `/usage`.
- **Agent + skill indexer** — walks user/plugin/project trees to build the catalog.
- **Dev server control** — per-project start/stop/restart buttons.
- **Live activity (hook server)** — `POST /api/hooks` accepts Claude Code lifecycle events.

> **Today**: active-subsystem toggles persist but require a server restart to take effect. A future wave will make them hot-toggle without restart. Toggles labelled **not wired** persist their value but no consumer reads them yet — flip them now if you want, the relevant wave will pick them up.

## Persistence

Every change PATCHes `/api/config`, which writes the merged value into `.minder.json` in the Project Minder repo. The change survives restarts. Unknown flag keys or non-boolean values are rejected (no silent fallback) — if a save fails, only that toggle reverts (other in-flight changes are preserved) and a toast surfaces the error.
