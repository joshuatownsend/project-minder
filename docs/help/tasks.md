# Tasks

**Mission Control > Tasks** shows the queue of work items dispatched to Claude Code agents. Each task represents one unit of work — a prompt, a code review, a refactor — that Project Minder tracks, schedules, and executes automatically.

## Task statuses

| Status | Meaning |
|--------|---------|
| **Pending** | Created, waiting to be picked up by the dispatcher |
| **Awaiting approval** | Requires human sign-off before the dispatcher will start it |
| **Running** | A `claude` CLI process is actively working on it |
| **Done** | Completed successfully |
| **Failed** | The process exited non-zero; can be re-run |
| **Cancelled** | Explicitly stopped or skipped |

## Creating tasks

Click **New task** in the toolbar to open the Task Composer. Fill in:

- **Title** (required) — the main prompt for Claude
- **Description** — additional context, constraints, or acceptance criteria
- **Quadrant** — Eisenhower matrix (Do / Schedule / Delegate / Archive)
- **Priority** — P1 (critical) through P5 (low)
- **Skill** — optional assigned skill to use (e.g. `code-review`)
- **Model** — optional model override (e.g. `claude-opus-4-7`)
- **Risk level** — Low / Medium / High
- **Run after** — optional datetime; the dispatcher won't pick up the task until then
- **Requires approval** — task waits in `awaiting_approval` until you approve it
- **Dry run** — dispatcher logs but does not spawn a child process

You can also create tasks via the REST API:

```
POST /api/tasks
{
  "title": "Refactor auth middleware",
  "description": "Extract rate-limiting into its own module",
  "priority": 2,
  "quadrant": "do",
  "requires_approval": false
}
```

## Approving and re-running tasks

- **Approve**: `POST /api/tasks/<id>/approve` — moves `awaiting_approval → pending`; dispatcher picks up on the next tick.
- **Re-run**: `POST /api/tasks/<id>/rerun` — resets a `failed` task to `pending` and clears all output fields.

## Dispatcher

The dispatcher is an in-process singleton (`globalThis.__minderDispatcher`) that starts automatically when the server handles its first request to `/api/tasks`. It:

1. Writes a heartbeat to `~/.minder/dispatcher-heartbeat.json` on each 30-second tick
2. Materializes due schedules into `ops_tasks` rows
3. Promotes `pending + requires_approval` tasks to `awaiting_approval`
4. Claims and spawns up to 3 concurrent `classic` mode tasks (via `claude -p`)
5. Writes a PID file to `~/.minder/pids/<pid>` for each spawned child (used by the Wave 9.2 emergency stop)

The dispatcher lifecycle is bound to the Next.js server process — restarting the server restarts the dispatcher. In-flight tasks survive short reloads because their PID files and DB rows persist.

## Fields reference

| Field | Description |
|-------|-------------|
| Priority | P1–P5; affects dispatcher pick order (P1 first) |
| Quadrant | Eisenhower: Do / Schedule / Delegate / Archive |
| Execution mode | `classic` (one-shot `claude -p`) or `stream` (Wave 9.1c) |
| Risk level | Low / Medium / High |
| Scheduled for | ISO timestamp; cron schedules populate this automatically |
| Session | Populated in stream mode when `claude` emits the init event |
| Cost / Duration | Written on completion |

## Schedules

Recurring tasks are driven by cron schedules. Create one at `POST /api/schedules` with a standard 5-field cron expression (e.g. `0 9 * * 1-5` = 09:00 on weekdays). The dispatcher materializes due schedules on each tick.

## What's coming

- **Wave 9.1c** — Stream mode (line-buffered JSON, `session_id` extraction)
- **Wave 9.2** — HITL: `DECISION:` / `INBOX:` marker parsing, decision queue, emergency stop
- **Wave 10** — Kanban board, task dependency graph, multi-agent swarm
