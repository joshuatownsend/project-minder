# Build Your Own Claude Code Dashboard — Prompt

Copy everything below the `---` line. In an empty folder on your Mac, start a
fresh Claude Code session and paste it in. Let it cook — this is a real build,
expect roughly two hours. When it's done, run `./install.sh` and open
`http://localhost:8765`.

If you want a walkthrough of how the pieces connect before running it, open
`build-your-own-dashboard-guide.html` in the same folder.

---

## Mission

Rebuild the dashboard I run every single day as my Claude Code command
centre. It's a real product — I operate my work from it. I want you to build
me an exact-fidelity clone from scratch, locally, on my Mac.

The quality bar is Linear / Raycast / Vercel. Dense signal, dark theme,
dialed-in typography, tasteful motion, production-grade polish. Nothing about
this should feel like a hackathon project.

Ship with intent. It runs entirely on my laptop. No cloud, no account, no
outbound telemetry.

## Audience

Me. A solo developer on Claude Code Pro/Max. I want to see what my agent is
doing, queue tasks, approve decisions from a dashboard, get pinged on
Telegram when things break, and kill runaway sessions with one button —
without maintaining eight microservices.

## Data sources

Two sources. Both already on my Mac. Ingest both.

### 1. Session JSONLs (always on)

Path: `~/.claude/projects/<project-hash>/<session-id>.jsonl`. One file per
session. Each line is a JSON event.

- `user` / `assistant` messages — `message.usage` has `input_tokens`,
  `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
- `tool_use` blocks — include `id`, `name`, `input`.
- `tool_result` blocks — pair to `tool_use` by `tool_use_id`. Duration is
  `tool_result.timestamp − tool_use.timestamp`. Cap at 10 minutes (anything
  longer is an orphan from a crashed session).
- `result` events at session end — carry `total_cost_usd`, `duration_ms`,
  `is_error`, `stop_reason`.

### 2. OTEL telemetry (opt-in, your install script turns it on)

When `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus OTLP endpoint envs point at the
dashboard, Claude Code posts:

- `POST /v1/logs` (OTLP/HTTP JSON) — logs with `event.name` attribute
- `POST /v1/metrics` (OTLP/HTTP JSON) — counters like
  `claude_code.commit.count`, `claude_code.pull_request.count`,
  `claude_code.lines_of_code.count`

Event names to handle: `tool_result`, `api_request`, `api_error`,
`hook_execution_start`, `hook_execution_complete`, `compaction`,
`tool_decision`. MCP tools arrive as `tool_name='mcp_tool'` with a
`tool_parameters` JSON attribute containing `mcp_server_name` +
`mcp_tool_name` (only when `OTEL_LOG_TOOL_DETAILS=1`). Fall back to parsing
`mcp__<server>__<tool>` from the JSONL side when OTEL is off.

## Stack (directive — build with these)

- **Backend**: Python 3.10+ (Python 3.9 works with `from __future__ import
  annotations`), FastAPI, uvicorn, SQLite with WAL mode. Single `.db` file
  on disk. All queries raw SQL, no ORM.
- **Frontend**: Vite + React 18 + TypeScript + Tailwind CSS + TanStack
  Router (file-based routing) + React Query (30s polling). Framer Motion
  for subtle animations. `lucide-react` for icons. Pre-built `ui/dist/`
  served by FastAPI as static.
- **Testing**: Playwright e2e tests in `ui/tests/e2e/` covering the main
  pages, command palette, schedule composer, theme toggle.
- **No**: Postgres, Supabase, Pinecone, external auth, WebSockets for
  observability (SSE fine where needed), Cloudflare tunnels, voice
  interfaces, agent avatars.

## Project layout

```
command-centre/
├── scripts/
│   ├── server.py            FastAPI app, all /api/*, /v1/logs, /v1/metrics
│   ├── db.py                SQLite schema + idempotent migrations helper
│   ├── sync_sessions.py     Scrape ~/.claude/projects/*.jsonl
│   ├── sync_cowork.py       Scrape Cowork audit.jsonl (optional)
│   ├── sync_skills.py       Rebuild skills registry
│   ├── live_sessions.py     In-flight session detection
│   ├── mcp_analyzer.py      MCP stats + per-server/per-tool latency
│   ├── notifier.py          Telegram outbound (30s loop, idempotent)
│   ├── setup_otel.py        Interactive OTEL wizard (backup + merge)
│   ├── setup_telegram.py    Interactive Telegram wizard (BotFather flow)
│   └── doctor.py            Deterministic health check (no LLM)
├── ui/
│   ├── src/
│   │   ├── routes/          TanStack Router — index.tsx, activity.tsx, skills.tsx, __root.tsx
│   │   ├── components/
│   │   │   ├── ui/          Card, Button, Sheet, Badge, StatePill, Tooltip, CollapsibleSection
│   │   │   ├── panels/      All 33 panels live here
│   │   │   └── layout/      AppShell, CommandPalette, nav
│   │   ├── hooks/useQueries.ts   Every React Query hook
│   │   └── lib/api.ts            Typed fetch wrappers + TS interfaces
│   ├── tests/e2e/           Playwright specs
│   └── dist/                Vite build output
├── .claude/skills/
│   ├── mission-control/     dispatcher.py, heartbeat.py, task_tracker.py, skill_router.py, session_state_hook.py
│   └── telegram/            telegram_handler.py, telegram_bot.py, telegram_send.py, dash_router.py, message_db.py
├── templates/launchd/       com.commandcentre.{mission-control,telegram-bot}.plist.template
├── data/                    SQLite DB lives here (created on install)
├── install.sh               One-command installer with wizard
├── cc                       Launcher shim: cc start|stop|restart|doctor|setup|sync|logs
├── requirements.txt         fastapi, uvicorn, pydantic, pyyaml, requests, python-dotenv
├── .env.example             Starter env
├── README.md                One-page user guide
├── ARCHITECTURE.md          System shape + data tables + concurrency model
└── HANDOVER.md              Runtime / debugging guide
```

## Database schema

All `CREATE TABLE IF NOT EXISTS`, WAL mode, idempotent migrations helper
(`_migrate_add_column(conn, table, col, type)`). Core tables:

- `sessions` — one row per JSONL session. Cols: `session_id` PK,
  `source` (`ide` / `cowork`), `cwd`, `git_branch`, `model`, `started_at`,
  `ended_at`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_create_tokens`, `total_tokens`, `effective_tokens`, `cost_usd`,
  `duration_ms`, `error_count`, `rate_limit_hit`, `stop_reason`, `title`,
  `synced_at`.
- `token_usage` — daily rollup per `(date, model, source)`. Cols: `date`,
  `model`, `source`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_create_tokens`.
- `tool_calls` — flattened per tool invocation. Cols: `session_id`,
  `tool_use_id`, `tool_name`, `ts`, `duration_ms` (nullable), `error`
  (nullable). Index on `(tool_name, ts)`.
- `otel_events` — every OTLP log event. Cols: `event_name`, `session_id`,
  `prompt_id`, `timestamp`, `model`, `tool_name`, `tool_success`,
  `tool_duration_ms`, `tool_error`, `cost_usd`, `api_duration_ms`,
  `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_create_tokens`,
  `speed`, `error_message`, `status_code`, `attempt_count`, `skill_name`,
  `skill_source`, `prompt_length`, `decision`, `decision_source`,
  `request_id`, `tool_result_size_bytes`, `mcp_server_scope`, `plugin_name`,
  `plugin_version`, `marketplace_name`, `install_trigger`, `mcp_server_name`,
  `mcp_tool_name`, `received_at`.
- `otel_metrics` — every OTLP metric. Cols: `metric_name`, `metric_type`,
  `value`, `session_id`, `model`, `timestamp`.
- `ops_tasks` — task queue. Cols: `id` PK, `title`, `description`, `status`
  (`pending`/`awaiting_approval`/`running`/`done`/`failed`/`cancelled`),
  `priority`, `assigned_skill`, `model`, `execution_mode` (`classic` /
  `stream`), `scheduled_for`, `requires_approval`, `risk_level`, `dry_run`,
  `quadrant` (`do`/`schedule`/`delegate`/`archive`), `approved_at`,
  `session_id`, `started_at`, `completed_at`, `duration_ms`, `cost_usd`,
  `output_summary`, `error_message`, `consecutive_failures`, `created_at`.
- `ops_schedules` — recurring schedules. Cols: `id`, `name`,
  `cron_expression`, `task_title`, `task_description`, `assigned_skill`,
  `enabled`, `next_run_at`, `last_run_at`, `created_at`.
- `ops_decisions` — HITL Q&A. Cols: `id`, `task_id`, `session_id`, `prompt`,
  `answer`, `status` (`pending`/`answered`), `created_at`, `answered_at`.
  Partial `UNIQUE(session_id, prompt) WHERE session_id IS NOT NULL` to
  dedupe duplicate marker lines.
- `ops_inbox` — non-blocking messages. Cols: `id`, `task_id`, `session_id`,
  `direction` (`agent_to_user` / `user_to_agent`), `body`, `read`,
  `created_at`.
- `activities` — append-only event log. Cols: `event_type`, `detail`,
  `metadata` (JSON), `created_at`. Event types include `heartbeat`,
  `notifier_heartbeat`, `sync_loop_heartbeat`, `loop_detected`.
- `live_session_state` — realtime session state written by a Claude Code
  hook. Cols: `session_id`, `state`, `current_tool`, `updated_at`.
- `mcp_stats` — per-server measurements. Cols: `server`, `tools`,
  `total_tokens`, `error`, `measured_at`.
- `mcp_schemas` — MCP tool schemas. Cols: `server`, `tool`, `schema_json`,
  `tokens`, `collected_at`.
- `skills` — skill registry. Cols: `name`, `environment`
  (`ide:project`/`ide:global`/`cowork:plugin`/`cowork:scheduled`),
  `description`, `path`, `autonomy_level` (`auto`/`review`/`manual`),
  `user_invocable`, `script_count`, `last_modified`.
- `system_state` — KV store. Cols: `key`, `value`, `updated_at`. Known keys:
  `emergency_stop` (`"1"` / `"0"`).
- `notification_log` — Telegram dedupe. Cols: `event_type`, `event_key`,
  `sent_at`, `chat_id`, `telegram_message_id`, `snoozed_until`.
  `UNIQUE(event_type, event_key, chat_id)`.

## Ingest layer

### JSONL sync (`scripts/sync_sessions.py`)

On boot and every 120s (lifespan loop), scan `~/.claude/projects/*/*.jsonl`.
For each session:
- Parse line-by-line.
- On `tool_use`: stash `(id, name, timestamp)` in a per-session map.
- On `tool_result`: look up by `tool_use_id`, compute duration (cap at 10
  min), write row to `tool_calls`.
- Accumulate token usage by model, write daily rows to `token_usage` with
  `DATE(timestamp, 'localtime')` bucketing (use local time for day
  extraction everywhere — UTC-bucketing breaks evening sessions).
- On session end: upsert `sessions` row with totals. Re-parse if
  `ended_at IS NULL` (session still active) or JSONL mtime > `synced_at`.

### OTEL ingest (`/v1/logs`, `/v1/metrics` in `server.py`)

Receive OTLP/HTTP JSON payloads. For each `LogRecord`:
- Parse `attributes` into a dict.
- Per-row try/except so one malformed event doesn't drop the batch.
  Count drops, log to stderr. Claude Code doesn't retry on 200 — the
  endpoint must be fault-tolerant.
- For `event.name='tool_result'` with `tool_name='mcp_tool'`, parse the
  `tool_parameters` JSON attribute to extract `mcp_server_name` and
  `mcp_tool_name`.
- INSERT into `otel_events`.

Metrics: INSERT into `otel_metrics` with `metric_name`, `metric_type`
(counter / gauge), `value`, `timestamp`.

## API surface

All endpoints under `127.0.0.1:8765`. JSON request/response. No auth.

### OTEL ingest

- `POST /v1/logs` — OTLP/HTTP JSON, always 200
- `POST /v1/metrics` — OTLP/HTTP JSON, always 200

### System + health

- `GET /api/health` — quick liveness
- `GET /api/system/health` — server uptime, memory, last OTEL event age,
  daemon last-tick age, notifier/sync loop ages, tzname
- `GET /api/system/state` — read `system_state` KV
- `POST /api/system/emergency-stop` — SIGTERM dispatcher-launched `claude
  -p` children ONLY (see Emergency Stop section). Return
  `{stopped: true, processes_killed: N, interactive_spared: M}`
- `POST /api/system/emergency-resume` — clear emergency flag
- `GET /api/attention` — aggregated issue feed (stuck loops, failed tasks,
  dispatcher stale, decisions pending)
- `GET /api/firehose` — SSE stream of recent OTEL events for the live
  firehose panel

### Sessions

- `GET /api/sessions` — paginated list with filters (range, source, model)
- `GET /api/sessions/{id}/details` — tool-call timeline + token breakdown
- `GET /api/sessions/live` — sessions active in last 5 min
- `GET /api/sessions/live/{sid}/state` — current live state row
- `GET /api/sessions/live/{sid}/stream` — SSE line-by-line feed
- `POST /api/sessions/live/{sid}/message` — queue follow-up into
  `.tmp/mission-control-queue/{sid}.jsonl`. Validate session_id is a UUID
  to block path traversal. Only works for `stream`-mode sessions.
- `GET /api/summary` — top-level KPIs: today's sessions / tokens / tools /
  errors
- `POST /api/sync` — manual trigger of sync loop

### Observability

All accept `?range=today|7d|30d`. Use local-time day bucketing.

- `GET /api/usage/tokens` — daily breakdown by model + source, totals at top
- `GET /api/usage/cache` — overall cache hit rate + daily trend. Low-sample
  badge below 10K billable tokens. Hit rate = `cache_read / (input +
  cache_read + cache_create)`. Target 70%+
- `GET /api/sessions/outcomes` — daily mutually-exclusive buckets in
  priority order: `errored > rate_limited > truncated > unfinished > ok`.
  Stacks must sum cleanly to day total
- `GET /api/tools/latency` — per tool p50/p95/max/error-rate/call-count.
  Sort by p95 desc
- `GET /api/hooks/activity` — hook_execution_start + _complete paired by
  session_id (FIFO queue per session, 60s outlier cap) to estimate hook
  durations. Daily fires + paired-duration counts
- `GET /api/sessions/by-project` — rollup by `cwd` — sessions, effective
  tokens, tool count per project
- `GET /api/tools/agent-fanout` — sessions that dispatched Agent tool
  calls. Proxy for subagent usage
- `GET /api/tools/edit-decisions` — accept/reject rate for Edit / MultiEdit
  / Write / NotebookEdit from `tool_decision` events. Low-sample badge
  under N=10
- `GET /api/activity/productivity` — OTEL counters
  `claude_code.{commit,pull_request,lines_of_code}.count`. These ARE
  delta-counters (verified — values non-monotonic). `SUM(value)` is correct
- `GET /api/system/pressure` — retry-exhaustion count (attempts ≥
  `CLAUDE_CODE_MAX_RETRIES`, default 10, env-configurable with try/except
  ValueError fallback), compaction count, recent api_errors

### MCP

- `GET /api/mcp` — list of servers with totals + avg latency + p95
- `GET /api/mcp/{server}/tools` — per-tool breakdown (calls, p50, p95, max,
  error rate). Use three sources in priority order: OTEL events with
  `mcp_server_name` (precise, post-`OTEL_LOG_TOOL_DETAILS=1`),
  `tool_calls.duration_ms` from JSONL pairing, legacy pre-generic-mcp_tool
  rows
- `POST /api/mcp/sync` — rebuild `mcp_stats`
- `POST /api/mcp/measure` — run schema-size measurement per server

### Skills

- `GET /api/skills` — list with filters (environment, user_invocable)
- `POST /api/skills/sync` — rebuild `skills` table
- `PATCH /api/skills/{name}/autonomy` — update autonomy level

### HITL — Decisions

- `GET /api/decisions?status=pending|answered` — list
- `POST /api/decisions` — create (from dispatcher parsing `DECISION:`
  markers). Use `INSERT OR IGNORE` on the partial UNIQUE index; return
  `{id, created: bool}`
- `POST /api/decisions/{id}/answer` — body `{answer: string}`. Write
  answer to queue file, dispatcher's stream loop injects into stdin once.
  Return `{answered: true}`

### HITL — Inbox

- `GET /api/inbox?unread=1&max_age_days=30` — list
- `POST /api/inbox` — agent-to-user message (from `INBOX:` markers)
- `POST /api/inbox/{id}/read` — mark read. Return `{read: true}`
- `POST /api/inbox/{id}/reply` — user reply. Writes to queue file. Return
  `{replied: true}`

### Tasks

- `GET /api/tasks` — filtered (status, quadrant)
- `POST /api/tasks` — create. Body: `{title, description, priority,
  quadrant, requires_approval, risk_level, dry_run, model, execution_mode
  (stream default for UI-created), assigned_skill, scheduled_for}`
- `PATCH /api/tasks/{id}` — update. Validate status transitions
- `DELETE /api/tasks/{id}` — delete
- `POST /api/tasks/{id}/approve` — flip `awaiting_approval` → `pending`
  and stamp `approved_at`. Return `{approved: true}`
- `POST /api/tasks/{id}/rerun` — only if `status='failed'` (400 otherwise).
  Reset to `pending`, clear `error_message` / `completed_at` / `started_at`
  / `duration_ms` / `output_summary` / `session_id`. Preserve
  `consecutive_failures`. Return `{rerun: true, task_id: N}`
- `POST /api/dispatcher/trigger` — spawn a one-shot dispatcher run via
  `subprocess.Popen(..., start_new_session=True)`. Wrap in
  `asyncio.to_thread`

### Schedules

- `GET /api/schedules` — list
- `POST /api/schedules` — create
- `PATCH /api/schedules/{id}` — update (clears `next_run_at` on cron change
  for immediate recompute)
- `DELETE /api/schedules/{id}` — return `{deleted: <schedule_id>}`
- `GET /api/schedules/{id}/runs?limit=10` — last N materialized tasks
- `POST /api/schedules/parse-nl` — natural-language → cron via Haiku.
  Wrap in `asyncio.to_thread`

## The panels (33)

Every panel below. Paired cards in 2-col grids use
`grid auto-rows-fr ... [&>*]:h-full` so heights match.

### Command page (index.tsx)

Fixed at top (always visible):

1. **SystemHealthStrip** — server uptime, memory, OTEL last-event age,
   daemon tick age, notifier/sync tick ages. Pills colored by health.
   `GET /api/system/health`.
2. **KpiRow** — today's sessions / tokens / tools / errors. 4 tiles. Skeleton
   while loading. `GET /api/summary`.
3. **AttentionBar** — red banner listing stuck loops, recent failed tasks,
   dispatcher staleness. Hides when all clear. `GET /api/attention`.

Then collapsible sections (`CollapsibleSection` wrapper, localStorage-
persisted open/collapsed state, `cc:section:<id>` key, chevron rotates 90°
on collapse, 220ms framer-motion height animation):

4. **Live sessions** — `LiveSessionsCard` + `LiveSessionDetail` slide-out
   drawer (right-side Sheet, ~460px). Row: title (last user message), cwd,
   model, token total, started-at. Drawer: tool-call timeline with
   start/end timestamps, input preview (truncated), output preview. Stream
   sessions get a follow-up message box at the bottom of the drawer;
   classic sessions show "Read-only — this task was queued as One-shot. Re-
   queue as Interactive to reply from the dashboard."
5. **Posture** — *NOT included in the free build.* See note at end.
6. **Token usage** — `TokenUsageCard`. today/7d/30d toggle. Stacked daily
   bar: input + output + cache-read + cache-create. Totals at top.
7. **Observability section** (`CollapsibleSection`) containing:
   - 2-col row: `CacheEfficiencyCard` + `SessionOutcomesCard`
   - 2-col row: `ToolLatencyCard` + `HookActivityCard`
   - 2-col row: `ProjectBreakdownCard` + `AgentFanoutCard`
   - 2-col row: `EditAcceptanceCard` + `ProductivityCard`
   - Full-width: `PressurePanel`
8. **HITL section**:
   - 2-col row: `DecisionsCard` + `InboxCard`
9. **Mission Control section**:
   - Full-width: `TaskBoard` + `TaskComposer` (slide-out Sheet)
   - Full-width: `SchedulesCard` + `ScheduleComposer` (slide-out Sheet)
10. **EmergencyStopBanner** — red header button with confirm dialog. Posts
    to `/api/system/emergency-stop`.

Descriptions of each observability panel:

- **CacheEfficiencyCard** — today/7d/30d toggle. Overall cache hit rate big
  number. Daily trend sparkline. Target-line at 70%. "low sample" badge if
  billable tokens in window < 10K.
- **SessionOutcomesCard** — today/7d/30d. Stacked daily bars. 5 colored
  segments: errored (red) / rate_limited (amber) / truncated (orange) /
  unfinished (grey) / ok (green). Must sum to day total.
- **ToolLatencyCard** — per-tool p50/p95/max + error rate. Sort by p95
  desc. Red flag when p95 ≥ 10s, green flag under 500ms. Show N (call
  count) next to each row.
- **HookActivityCard** — daily fires per hook + paired-duration estimate
  (cap 60s, FIFO queue per session). Empty-state when `totalFires === 0`.
- **ProjectBreakdownCard** — sessions grouped by `cwd`. Show project name
  (basename or `~/...`), sessions count, effective tokens, % of total.
  Regex-based home-dir strip: `cwd.replace(/^\/Users\/[^/]+/, '~')` — do
  NOT hardcode a username.
- **AgentFanoutCard** — sessions that ran the Agent tool. Session title +
  Agent call count. Fallback to session_id when title is null, prefix with
  muted `session:`.
- **EditAcceptanceCard** — accept/reject rates for Edit/MultiEdit/Write/
  NotebookEdit from `tool_decision` events. Low-sample badge under N=10.
- **ProductivityCard** — OTEL counters: commits, PRs, lines added/removed.
  Empty state when all zero AND `daily` array empty.
- **PressurePanel** — retry exhaustion count (threshold from
  `CLAUDE_CODE_MAX_RETRIES` env, default 10; surface threshold in
  response), compaction count, last 10 api_errors with attempt counts.

**DecisionsCard** — list of pending decisions with prompt preview, Answer
button opens modal. `GET /api/decisions?status=pending`, poll 5s.
**InboxCard** — list of unread `agent_to_user` messages with reply box.
Poll 10s.

**TaskBoard** — 3 columns (pending / running / done). Each card: title,
description preview, skill badge, model badge, quadrant dot, risk pill,
dry-run badge. Actions per status: Approve (awaiting_approval), Rerun
(failed only — gate on `t.status === 'failed'` only, not done), Delete.
**TaskComposer** — slide-out Sheet. Fields: title (autofocus), description
textarea, model select (default "" → from skill), mode picker
(Interactive/One-shot, **default Interactive**, labels: "Reply mid-run
from the dashboard" / "Fire and forget — no back-and-forth"), priority,
quadrant, risk level, requires_approval checkbox, dry_run checkbox with
tooltip.

**SchedulesCard** — list of schedules with name, cron preview, enabled
toggle, next-run countdown, delete. Expand row for last 5 runs. TZ in
header (`datetime.now().astimezone().tzname()`, env-overridable via
`TZ`). Stale detection: `next_run_at < now - 5min` → amber dot.
**ScheduleComposer** — slide-out. Time picker (hour 0-23 + minute
0/15/30/45), Mon–Sun chips with quick-select (Every day / Weekdays /
Weekends), live cron preview, task title, task details, skill picker,
enabled toggle. Cron derived client-side. Day-of-week uses Python
`dt.weekday()` convention (Mon=0..Sun=6) to match the heartbeat parser.

### Activity page (activity.tsx)

Under a route `/activity`. CollapsibleSection wrapper per group:

11. **Patterns** — `HeatmapGrid` (30-day GitHub-style daily grid) +
    `ChartsStrip` (14-day stacked token charts by model).
12. **Telemetry firehose** — `OtelPanel` (SSE subscription to
    `/api/firehose`, scrolling event feed, filter by event_name).
13. **Top skills + failures** — `TopSkills` (most-used skills with token
    cost) + `UnifiedFailures` (crashed sessions with error messages from
    JSONL stderr + session result is_error).
14. **All sessions** — `SessionsTable` (searchable, paginated, filter by
    range / source / model).

Optional: `ActivityFirehose` as a full-page firehose view.

### Skills & MCP page (skills.tsx)

Under route `/skills`. CollapsibleSection per group:

15. **MCP servers** — `MCPPanel`. List of servers with totals + avg
    latency + p95. Row click expands per-tool table (p50/p95/max/err-
    rate/N). Tools with p95 ≥ 10s: `· slow` red tag. Sub-500ms: `· fast`
    green tag. Fetch `GET /api/mcp/{server}/tools?range=7d|30d` on expand.
    **Make this panel extraordinary** — it's the centerpiece. When I open
    this I want to see my Notion MCP at 14s p95 and feel it.
16. **Skill economics** — `SkillCostCard`. Token cost per skill across
    sessions. Sort by total.
17. **Context health + registry** — 3-col layout:
    - `ContextHealthCard` (read-only scan of `~/.claude/settings.json` +
      `CLAUDE.md` — line count, rule count, MCP server count, hook count,
      file size. Does NOT run an LLM)
    - `SkillsRegistry` (col-span-2) — table of all skills across
      environments with autonomy controls.

### Shared UI components

- `CollapsibleSection` — `{id, title, subtitle?, summary?, defaultOpen}`.
  localStorage-persisted (`cc:section:<id>`). Chevron rotates. Framer-
  motion height animation. Proper aria-expanded / aria-controls.
- `Sheet` — right-side slide-out drawer with Esc-to-close, focus trap,
  aria-modal.
- `Card` primitives (`Card`, `CardHeader`, `CardTitle`, `CardDescription`,
  `CardContent`, `CardFooter`) — rounded-xl, subtle border, surface
  background.
- `Button` — primary (gradient) / secondary / ghost.
- `Badge`, `StatePill` — colored pills for status indicators.
- `Tooltip` — hover-delay tooltip with arrow.
- `CommandPalette` — ⌘K to open. Fuzzy-search pages + queue-a-task quick
  action.

## Mission Control dispatcher

Separate process. Lives in `.claude/skills/mission-control/scripts/`.

### `heartbeat.py`

Launchd-driven, 120s cadence. Every tick:
1. `task_tracker.claim_pending()` — atomic `UPDATE ops_tasks SET status=
   'running' WHERE id=? AND status='pending'` with rowcount check. Prevents
   daemon + manual `--once` racing.
2. Materialize schedules: `SELECT * FROM ops_schedules WHERE enabled=1 AND
   (next_run_at IS NULL OR next_run_at <= ?)`. For each match: create
   `ops_tasks` row, update `ops_schedules.next_run_at` via
   `parse_cron_simple()`. Wrap in `BEGIN IMMEDIATE` to avoid double-
   materialization across concurrent heartbeats.
3. Invoke `dispatcher.run_once()`.
4. Write `activities(event_type='heartbeat', ...)`.

### `dispatcher.py`

`run_once()`:
- Honors `system_state.emergency_stop`. Early-return when set.
- `_sweep_stale_pids()` — clean `.tmp/mission-control-queue/pids/` of PIDs
  whose processes no longer exist (signal 0 probe).
- For up to `MAX_CONCURRENT` (default 3) pending tasks:
  - Skill autonomy check. `manual` → promote to `awaiting_approval`.
    `review` → also promote. `auto` → run.
  - Branch by `execution_mode`:
    - `classic`: `subprocess.Popen(['claude', '-p', prompt, ...])`,
      `_mark_child_pid(proc.pid)`, `proc.communicate(timeout=...)`,
      `_unmark_child_pid` in finally. Capture stdout, write
      `output_summary`. Handle `TimeoutExpired` by killing.
    - `stream`: `subprocess.Popen` with stdin=PIPE, stdout=PIPE,
      stderr=PIPE, `bufsize=1`. Reader threads drain stdout into a
      queue. `_mark_child_pid(proc.pid)`; `_unmark_child_pid` in finally.
      Parse each JSON line. On `type='system', subtype='init'`, stash
      `session_id` back to `ops_tasks`. On assistant text, scan for
      `DECISION:` / `INBOX:` markers (line-based, skip triple-backtick
      fenced blocks). On `DECISION:` create `ops_decisions` via
      `INSERT OR IGNORE`, block on poll (interval 2s, up to
      `TASK_TIMEOUT_SECONDS`), inject answer via `proc.stdin.write` once.
      On `INBOX:` post to `/api/inbox`. Poll
      `.tmp/mission-control-queue/{sid}.jsonl` for user follow-ups, seek
      from last offset, inject each line to stdin.

`_build_env()` sets `CLAUDE_CODE_ENABLE_TELEMETRY=1` + the OTEL env vars
+ `ATOMICOPS_DISPATCHED=1` (legacy marker; PID files are the real safety
gate). **Set up PID marker files in `.tmp/mission-control-queue/pids/{pid}`
for every spawned child; delete on exit. This is how emergency stop
targets only dispatched children.**

`resolve_model()` priority: task.model → skill frontmatter →
`MISSION_CONTROL_DEFAULT_MODEL` env → CLI default.

### `task_tracker.py`

`create_task(title, description, priority, assigned_skill, scheduled_for,
model, execution_mode)` — simple INSERT.
`claim_pending(task_id)` — atomic UPDATE, returns claimed row or None.
`update_task`, `complete_task`, `fail_task` — self-explanatory.

### `skill_router.py`

Haiku-powered skill picker for unassigned tasks. Takes task title +
description + list of skill descriptions, returns best skill name.
Cheap call (~$0.0001 per pick).

### `session_state_hook.py`

Claude Code hook target. Writes `live_session_state` row per session
lifecycle event. Referenced from `~/.claude/settings.json` hooks array if
the user wants live-session awareness (optional, documented in README).

### Launchd plist

`templates/launchd/com.commandcentre.mission-control.plist.template` with
placeholders `{{PYTHON}}`, `{{INSTALL_DIR}}`, `{{PROJECT_ROOT}}`, `{{PORT}}`,
`{{DEFAULT_MODEL}}`. Key settings: `RunAtLoad=true`, `KeepAlive=true`,
`ThrottleInterval=30`. **Do NOT hardcode `/usr/bin/python3` as the
interpreter** — that's Python 3.9 on macOS and breaks if any module uses
3.10+ syntax. Point to homebrew Python or the venv Python.

## Emergency stop

`POST /api/system/emergency-stop`:
1. Scan `.tmp/mission-control-queue/pids/` for PID files.
2. For each PID file: `os.kill(pid, 0)` to verify alive. If dead, unlink.
3. Verify PID is a `claude -p` process: run `ps -p {pid} -o command=` and
   check argv contains `claude` and `-p`. Defence against PID recycling.
4. SIGTERM alive `claude -p` PIDs. Unlink marker files. Tally `killed`.
5. Set `system_state.emergency_stop = '1'`.
6. `UPDATE ops_tasks SET status='failed', error_message='Emergency stop
   triggered' WHERE status='running'`.
7. Return `{stopped, processes_killed, interactive_spared}`.

**Why PID files and not env-var scanning via `ps eww`:** macOS 12+
restricts env disclosure to root. The `ATOMICOPS_DISPATCHED=1` env marker
is invisible to `ps eww` at user privilege. PID files on disk are the only
reliable way to identify dispatched children without false positives.

## Telegram bridge (optional)

Ship the code but make it opt-in during install.

### `scripts/setup_telegram.py`

Interactive wizard:
1. Show BotFather instructions + link (create bot, get token).
2. Prompt for bot token.
3. Show how to get chat_id (`@userinfobot`).
4. Prompt for chat_id.
5. Test the token: `POST sendMessage` with `"✓ Command Centre is wired
   up."`. Abort with clear error if fail.
6. Write `.claude/skills/telegram/references/messaging.yaml` with
   `allowed_user_ids`.
7. Append `TELEGRAM_BOT_TOKEN` + `TELEGRAM_DASH_CHAT_ID` to install-dir
   `.env`, chmod 600.
8. Remind to restart the server + (if used) launchd telegram agent.

### `scripts/notifier.py`

30s lifespan loop inside the FastAPI app. Every tick, check for:
1. `ops_decisions WHERE status='pending'` → "❓ Decision waiting" + inline
   buttons: `✓ Approve`, `Snooze 30m`.
2. `ops_tasks WHERE status='awaiting_approval'` → "🟡 Approval needed" +
   `✓ Approve`, `Dismiss`.
3. `ops_tasks WHERE status='failed' AND completed_at >= now-24h` → "⚠️
   Task failed" + `↻ Re-run`, `Dismiss`.
4. `ops_schedules WHERE enabled=1 AND next_run_at < now-5min` → "⏰
   Schedule overdue" + `Disable`, `Dismiss`.
5. `ops_inbox WHERE read=0 AND direction='agent_to_user'` → "📨 Inbox" +
   `✓ Mark read`, `Dismiss`.

**Plain text only — no `parse_mode="markdown"`.** DB-sourced content
(error messages, decision prompts) can contain unescaped backticks which
fail markdown parsing silently and create infinite retry loops. Drop
`parse_mode` entirely.

Dedupe via `notification_log` `UNIQUE(event_type, event_key, chat_id)`.
Snooze = UPDATE `snoozed_until = now + 30m`. `_already_notified()` re-fires
when snooze elapses.

Inline button callbacks all use `dash:<action>:<id>` prefix, e.g.
`dash:dec_approve:42`, `dash:task_rerun:17`, `dash:dismiss`.

### `.claude/skills/telegram/scripts/`

- `telegram_send.py` — reusable outbound (used by notifier.py). Handles
  inline buttons.
- `telegram_handler.py` — polling daemon. `getUpdates` loop. For each
  update: whitelist check (`allowed_user_ids`), then route. Text →
  Claude CLI. Callback → `dash_router.py`.
- `telegram_bot.py` — routing logic. `process_callback_query`: if
  `data.startswith("dash:")`, route to `dash_router.route()` BEFORE the
  Claude-chat flow.
- `dash_router.py` — `route(data, chat_id)`: parse `dash:<action>:<id?>`,
  POST to `DASHBOARD_URL` (default `http://127.0.0.1:8765`), reply with
  confirmation. `_snooze()` must return real rowcount — callers surface
  "No active notification" when rowcount=0.
- `message_db.py` — per-chat conversation state + per-message log. Use
  SQLite (table `ops_messages` + `ops_conversations` with
  `UNIQUE(platform, chat_id)`). No Postgres dependency.

### Launchd plist (Telegram)

`templates/launchd/com.commandcentre.telegram-bot.plist.template`. Only
installed if the user opted into Telegram.

## Setup UX

### `install.sh`

Single entry point. Args: `--yes`, `--project-root=PATH`, `--port=N`,
`--model=M`, `--no-otel`, `--no-launchd`, `--telegram`, `--no-telegram`,
`--no-start`.

Flow:
1. Arg parsing.
2. Python detection — prefer `/opt/homebrew/opt/python@3.12/libexec/bin/
   python3`, fall back to `python3.13` → `python3.12` → ... → `python3.9`.
   Gate on `>= 3.9` (warn on 3.9 because of PEP 604 gotchas elsewhere).
3. Project root resolution: `--project-root` flag → `$PWD/.claude` check →
   interactive prompt.
4. Cowork auto-detect: `~/Library/Application Support/Claude/local-agent-
   mode-sessions/`, fall back to glob.
5. Create `~/.command-centre/` layout: `scripts/`, `.claude/skills/`,
   `ui/`, `data/`, `logs/`, `bin/`.
6. Copy ALL `scripts/*.py` + `vendor-skills.sh` (if present). Copy entire
   `ui/dist/` tree. Copy `.claude/skills/` tree. Copy `requirements.txt`.
7. Seed `config` (install-time snapshot of vars) and `.env` from
   `.env.example`.
8. Create venv: `"$PYTHON" -m venv "$VENV_DIR"`. Install from
   `requirements.txt`.
9. Write launcher scripts: `start.sh` (sources config + .env, execs
   server), `stop.sh` (pkill).
10. Write `cc` shim to `bin/` with subcommands: `start`, `stop`, `restart`,
    `doctor`, `setup otel`, `setup telegram`, `sync`, `logs`.
11. Symlink `bin/cc` into `~/.local/bin/cc` if that's on PATH.
12. Run OTEL wizard unless `--no-otel`.
13. Ask about Telegram unless `--no-telegram` or already decided.
14. Render + load launchd plists from `templates/launchd/` unless
    `--no-launchd`. Render with `sed -e 's|{{PYTHON}}|...|g' ...`.
15. Start server unless `--no-start`.
16. Print next steps: open localhost:8765, restart Claude Code if OTEL
    enabled, run `cc doctor`.

### `scripts/setup_otel.py`

- Read `~/.claude/settings.json` (create empty if missing).
- Diff against required keys:
  - `CLAUDE_CODE_ENABLE_TELEMETRY=1`
  - `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:8765`
  - `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`
  - `OTEL_METRICS_EXPORTER=otlp`
  - `OTEL_LOGS_EXPORTER=otlp`
  - `OTEL_LOG_TOOL_DETAILS=1`
- Show which are missing. Prompt `[Y/n]` unless `--yes`.
- Back up the file: `settings.json.bak.<YYYYMMDD-HHMMSS>` via
  `shutil.copy2`.
- Write merged JSON. **Only add missing keys — never overwrite user's
  existing values.**
- Remind the user to quit and restart Claude Code.

### `scripts/doctor.py`

Zero LLM calls. Prints green/red checks with colored output:

- Python version (warn if < 3.10)
- `claude` CLI on PATH (warn if not)
- `~/.claude/settings.json` exists + all 6 OTEL keys present
- `~/.claude/projects/` exists + session file count
- `CC_PROJECT_ROOT` env check
- Dashboard port reachable (socket probe)
- Fetch `/api/system/health` → render uptime, OTEL age, daemon age,
  notifier/sync ages
- `launchctl list` check for `com.commandcentre.{mission-control,telegram-
  bot}`
- Telegram bot reachability (if `TELEGRAM_BOT_TOKEN` set, `getMe`)

Exit 0 if everything green, non-zero if any critical check fails.

## Visual direction

Not "dark with one accent." Build something production-grade.

**Palette** — `--bg: #0a0a0f`, `--surface: #12121a`, `--surface-2: #1a1a27`,
`--border: #2a2a3d`, `--border-glow: #3d3d5c`, `--text: #e8e8f0`,
`--text-dim: #8888a0`, `--text-subtle: #5a5a70`. Accent gradient:
`linear-gradient(135deg, #4d7cff, #8b5cf6)`. Status: green `#10b981`, amber
`#f59e0b`, red `#ef4444`, cyan `#06b6d4`.

Background gets layered radial gradients for subtle depth:
`radial-gradient(circle at 20% 10%, rgba(77,124,255,0.08), transparent
40%)` + one purple glow offset elsewhere.

**Typography** — Inter for body (400/500/600/700/800). JetBrains Mono for
labels, kickers, numeric displays, code. Uppercase section labels (kickers)
with 1.5–2px letter-spacing in mono.

**Layout** — Card-based. 14–16px border radius. 24–32px padding. Grid
rows use `auto-rows-fr` + `[&>*]:h-full` so paired cards match heights.

**Motion** — Panel fade-in on mount (~300ms). CollapsibleSection height-
animates at 220ms ease-out. Chevron rotates 90° on collapse. Button hover
lifts 2px with shadow growth. No scroll-jacking, no parallax, no hero
animations.

**Data display** — Relative time ("3 min ago") with absolute timestamp on
hover tooltip. Numbers right-aligned in tables. Loading skeletons (not
spinners) on every panel. Clear empty states that teach the user what's
happening — not just "no data."

**Icons** — `lucide-react`. One-style, clean, modern.

**Keyboard UX** — `⌘K` opens the CommandPalette. Sheets close on Esc.
Focus rings visible. Forms submit on Enter.


## Stop conditions

You're done when:

1. `./install.sh` runs clean on a fresh directory.
2. `http://localhost:8765` loads. All three routes (`/`, `/activity`,
   `/skills`) render. Every panel either shows real data or a proper empty
   state — no placeholder text, no layout jumps, no spinner-only states.
3. After enabling OTEL and restarting Claude Code, new events appear in
   the dashboard within 30 seconds.
4. MCP panel: click a server → per-tool breakdown animates in smoothly.
5. Queue a task via the dashboard in Interactive mode → dispatcher picks
   it up → task runs end-to-end → output appears in TaskBoard done column.
6. Create a schedule via the composer → `next_run_at` populates → wait
   past the time → schedule materializes a task.
7. Emergency stop: dispatch a sleeping task → click red button → that
   child is SIGTERM'd AND an interactive `claude -p` in a separate
   terminal survives.
8. `cc doctor` exits 0 with all-green checks.
9. `npx playwright test` passes end-to-end.

## Order of operations

1. Read this entire prompt first. Don't start until it clicks.
2. **Data layer**: read a handful of my real JSONL files from
   `~/.claude/projects/`. Confirm the shapes. Design the full schema. Show
   me the schema before building more so I can sanity-check.
3. **Ingest**: `sync_sessions.py` + `/v1/logs` + `/v1/metrics`. Verify with
   a real JSONL dump + a manual OTEL POST.
4. **API**: every `/api/*` endpoint from the surface list. Use raw SQL.
   Per-row try/except on ingest. Local-time day bucketing everywhere.
5. **Mission Control**: `dispatcher.py` + `heartbeat.py` + `task_tracker`
   + PID marker files + DECISION:/INBOX: parser (fence-aware). Launchd
   plist template.
6. **Dashboard shell**: TanStack Router, AppShell with nav, CollapsibleSection,
   Sheet, Card primitives, theme tokens, reusable hooks.
7. **Panels**: build in display order. MCP drill-down last — save the
   centerpiece for when your rhythm is dialed.
8. **HITL**: DecisionsCard + InboxCard + LiveSessionDetail follow-up box.
9. **Telegram**: `setup_telegram.py` wizard + `notifier.py` + handler +
   dash router + launchd plist.
10. **Setup**: `install.sh` + `setup_otel.py` + `doctor.py` + `cc` shim.
11. **Playwright tests**: main pages render, command palette opens,
    schedule composer creates a schedule, theme toggle persists.
12. **Verify** against every stop condition. Run `cc doctor`. Then
    screenshot the main view and drop it in README.md.

Build the whole thing. Don't strip features. Ship it at the quality bar I
set in the Mission section. If you think something is unclear, read this
prompt again before asking — almost everything you need is in here.
