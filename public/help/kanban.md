# Mission Control — Kanban

The Kanban page (`/kanban`) gives you a single-glance view of everything happening across your Claude Code sessions and dispatcher tasks, organized into five columns.

## View modes

Use the **Board / Dag / Gantt** toggle in the toolbar to switch how the Kanban data is displayed.

### Board (default)

Five-column card layout. Dispatcher tasks show a **blocked (N)** chip when they are waiting on one or more blocker tasks that haven't finished yet.

### Dag — dependency graph

A layered SVG graph where each node is a task and each arrow points from a blocker to its dependent ("blocker → dependent" read left to right). Tasks with no dependency edges are excluded. Click any node to jump to `/tasks?focus=<id>`.

Empty state: appears when no tasks have dependency edges yet.

### Gantt — time chart

A horizontal bar chart with one row per task, sorted by dependency layer (blockers above dependents). Bars represent the task's real execution window (`started_at → completed_at`). Tasks still in flight extend to the current time. Pending/awaiting-approval tasks render a hollow placeholder bar (not a real estimate). Dependency arrows connect blocker bar-right to dependent bar-left.

Empty state: appears when no task data exists for the selected period.

View mode is persisted in `localStorage` under `minder:kanban:view-mode`.

## Columns

| Column | What goes here |
|--------|---------------|
| **Working** | Sessions actively running a tool; tasks with `running` status |
| **Waiting** | Sessions waiting for your permission (approval); tasks awaiting your approval (`awaiting_approval`) |
| **Idle** | Sessions that have finished a turn and are waiting for your next message; tasks queued as `pending` or `cancelled` |
| **Done** | Tasks with `done` status |
| **Error** | Tasks with `failed` status |

## Task dependencies

You can declare that one task must complete before another is dispatched. This is called a **blocking relationship**: task B is *blocked by* task A means B will not be claimed by the dispatcher until A reaches `done` status.

### Creating dependencies

Open the **Task Composer** (`+ New task`), fill in the task details, then check one or more tasks under **Depends on (optional)**. The dependency edges are inserted atomically with the task — if any edge would create a cycle, the whole creation fails with a 409 error.

You can also add edges after creation via the REST API:
```
POST /api/tasks/{id}/dependencies     { "blockerId": <number> }
DELETE /api/tasks/{id}/dependencies/{blockerId}
```

### Blocker semantics

**Only `done` unblocks a dependent.** A blocker that ends in `failed` or `cancelled` keeps its dependents blocked indefinitely. To clear the hold:
- **Rerun** the failed/cancelled blocker task (moves it back to `pending` for the dispatcher to retry).
- **Remove** the dependency edge via `DELETE /api/tasks/{id}/dependencies/{blockerId}`.

This is intentional: a cancelled task usually means "this didn't go the way we planned" — the dependent shouldn't proceed on a potentially half-done state.

### Cycle prevention

The API rejects edges that would create a cycle (direct or transitive) with `409 Conflict`. The graph is always a DAG; the Dag view can safely assume acyclic input.

## Live / awaiting dots

Session cards show a colored dot:

- **Green dot** — session is actively working (tool calls in progress)
- **Amber dot** — session is waiting for your permission to write a file

These states are derived from the last 200 lines of each session's JSONL file, refreshed every 6 seconds.

## Period selector

The period filter controls the horizon for the **Done** and **Error** columns:

- **Last 24 h** (default) — shows completions from the past day
- **Last 7 d** — shows the past week
- **All time** — shows every terminal-state task ever

`Working`, `Waiting`, and `Idle` columns always include all current open work, regardless of the period setting.

## Column visibility

Use the **Columns** dropdown to hide columns you don't need. Visibility preferences are saved per-browser in `localStorage` under the key `minder:kanban:hidden-columns`. They are not synced to `.minder.json`.

## Dispatcher-disabled state

If the `taskDispatcher` feature flag is disabled in Settings, the board renders a banner and shows sessions only. No task cards will appear. Re-enable the flag and reload to restore the task lane.

## Keyboard navigation

- **Tab** — moves through cards in column order (Working → Waiting → Idle → Done → Error)
- **Enter / Space** — activates the focused card link
- **Escape** — closes the Columns dropdown when open

## Refresh

The board polls `GET /api/kanban` every 6 seconds automatically. Polling pauses when the browser tab is hidden and resumes when you return. Click the refresh icon in the toolbar to force an immediate update.

## Session cards

Clicking a session card opens `/sessions/<sessionId>` — the full session detail view.

## Task cards

Clicking a task card opens `/tasks?focus=<taskId>` — the Tasks page with that task highlighted.
