# Tasks

**Mission Control > Tasks** shows the queue of work items dispatched to Claude Code agents. Each task represents one unit of work — a prompt, a code review, a refactor — that Project Minder can track, schedule, and (in Wave 9.1b) execute automatically.

## Task statuses

| Status | Meaning |
|--------|---------|
| **Pending** | Created, waiting to be picked up by the dispatcher |
| **Awaiting approval** | Requires human sign-off before the dispatcher will start it |
| **Running** | A `claude` CLI process is actively working on it |
| **Done** | Completed successfully |
| **Failed** | The process exited non-zero or timed out |
| **Cancelled** | Explicitly stopped or skipped |

## Fields

- **Priority** — P1 (critical) through P5 (low). Affects dispatcher pick order.
- **Quadrant** — Eisenhower matrix: Do / Schedule / Delegate / Archive.
- **Execution mode** — `stream` (default, shows live output) or `classic`.
- **Risk level** — Low / Medium / High. High-risk tasks can require approval.
- **Scheduled for** — ISO timestamp; cron-based schedules populate this automatically.
- **Session** — Populated by the dispatcher when `claude` starts (Wave 9.1b).
- **Cost / Duration** — Filled in by the dispatcher on completion.

## Creating tasks

Use the REST API directly until the Task Composer modal ships in Wave 9.1b:

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

## Schedules

Recurring tasks are driven by cron schedules. Create one at `POST /api/schedules` with a standard 5-field cron expression (e.g. `0 9 * * 1-5` = 09:00 on weekdays). The cron materializer — which turns schedules into `ops_tasks` rows — ships in Wave 9.1b alongside the dispatcher loop.

## What's coming in Wave 9.1b

- Dispatcher loop — picks up `pending` tasks and spawns `claude` CLI processes
- Cron materializer — creates task rows from enabled schedules on each tick
- Task Composer modal — create tasks from the UI
- Approve / Re-run buttons on individual tasks
- PID tracking and emergency-stop
