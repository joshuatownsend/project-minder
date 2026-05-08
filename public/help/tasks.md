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
- **Execution mode** — `Classic (text)` uses `claude -p --output-format text`; `Stream (JSON)` uses `--output-format stream-json --verbose` and captures the `session_id` mid-run
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
4. Claims and spawns up to 3 concurrent tasks — `classic` mode via `claude -p --output-format text`, `stream` mode via `claude -p --output-format stream-json --verbose`
5. In stream mode, writes `session_id` to the task row as soon as the init event arrives (before the task completes)
6. Writes a PID file to `~/.minder/pids/<pid>` for each spawned child (used by the Wave 9.2 emergency stop)

The dispatcher lifecycle is bound to the Next.js server process — restarting the server restarts the dispatcher. Tasks that were `running` when the server stopped will remain stuck in that state; use the re-run endpoint to reset them to `pending`.

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

## HITL — Human-in-the-Loop decisions

When a stream-mode task emits a `DECISION:` or `INBOX:` marker on stdout, Project Minder surfaces it on the dashboard and lets you respond without touching a terminal.

### Marker syntax

```
DECISION: Should I overwrite the existing migration? [yes, no, skip]
INBOX: Still scanning — found 14 candidates so far
```

- **`DECISION:`** — a blocking prompt. The dispatcher keeps the child running and records the decision in the `task_decisions` table. Choices in `[a, b, c]` format are rendered as clickable buttons; free-text is accepted for any decision.
- **`INBOX:`** — a non-blocking status update. Recorded in the same table but requires no reply.

Markers inside triple-backtick code fences are silently ignored (fence-aware parser).

### Decisions panel

When a running task has pending decisions, a **Decisions** panel appears above the project grid. Each card shows the task title, the decision prompt, and choice buttons (or a text field). Clicking a choice or submitting text:

1. Writes the answer to the child's stdin pipe followed by `\n`
2. Marks the `decided_at` timestamp in `task_decisions`
3. Removes the card from the panel

If the task finishes before you respond, the panel shows "Task already finished" and the card is removed.

### Inbox panel

An **Inbox** panel below the Decisions panel shows recent `INBOX:` messages from all running tasks. It refreshes every 5 seconds alongside the Pulse ticker.

### API

```
GET  /api/decisions        — open decisions, supports ?taskId=<id>
GET  /api/inbox?limit=N    — recent inbox messages
POST /api/tasks/<id>/decide
     { "decisionId": 42, "answer": "yes" }
```

Returns 410 if the stream child has already exited.

### TasksBrowser badge

Tasks with pending decisions show a **⏸ N waiting** badge on their row in the Tasks table.

---

## Emergency stop

The **Stop** button (top-right of every page when the `taskDispatcher` feature flag is on) lets you immediately kill all active dispatcher-spawned Claude processes.

### How it works

1. Reads every PID from `~/.minder/pids/`
2. Verifies each one is a `claude` process via `tasklist /FI "PID eq <pid>"` (Windows) or `ps -p` (POSIX)
3. Calls `killProcessTree(pid)` — uses `taskkill /F /T` on Windows so cmd.exe wrappers and child processes all terminate
4. Counts non-`claude` PIDs as **interactively spared** — any Claude Code session you started manually in your terminal is left alone
5. Sets `emergency_stop: true` in `~/.minder/config.json`

While the emergency stop flag is set, the dispatcher skips claim and spawn on each tick (heartbeat continues). The button turns green and shows **Resume dispatcher**.

### Resume

Clicking **Resume** sends `POST /api/tasks/emergency-stop/resume`, which clears the flag. The dispatcher picks up pending tasks on its next 30-second tick.

### API

```
POST /api/tasks/emergency-stop        — kills confirmed children, sets flag
POST /api/tasks/emergency-stop/resume — clears flag, dispatcher resumes
```

Both return a JSON body with `processesKilled`, `interactiveSpared`, `errors`.

---

## TODO delegation

Any unchecked item in a project's `TODO.md` can be delegated to the dispatcher with one click.

### Delegate button

Open a project's **TODOs** tab. Each unchecked item shows a small **Delegate** icon-button on the right (visible when the `taskDispatcher` flag is on). Clicking it:

1. Creates an `ops_tasks` row with the TODO text as the title, `quadrant = delegated-todo`, and metadata recording the source file and line number
2. The dispatcher picks up the task on its next tick and runs it like any other stream-mode task
3. When the task completes, Project Minder automatically toggles the checkbox in `TODO.md` from `[ ]` to `[x]`

The auto-toggle is best-effort — if the file was deleted or locked, the task still completes and a warning is logged.

### Finding delegated tasks

In the Tasks page, use the **Source** filter to select **From TODOs** — this shows only `quadrant = delegated-todo` tasks.

### API

```
POST /api/projects/<slug>/todos/delegate
     { "lineNumber": 7 }
```

Returns `{ "taskId": 123 }`.

---

## What's coming

- **Wave 10** — Kanban board, task dependency graph, multi-agent swarm
