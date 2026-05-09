# Mission Control — Kanban

The Kanban page (`/kanban`) gives you a single-glance view of everything happening across your Claude Code sessions and dispatcher tasks, organized into five columns.

## Columns

| Column | What goes here |
|--------|---------------|
| **Working** | Sessions actively running a tool; tasks with `running` status |
| **Waiting** | Sessions waiting for your permission (approval); tasks awaiting your approval (`awaiting_approval`) |
| **Idle** | Sessions that have finished a turn and are waiting for your next message; tasks queued as `pending`; cancelled tasks |
| **Done** | Sessions whose JSONL history shows `done`; tasks with `done` status |
| **Error** | Sessions whose history shows an error or cancellation by Claude; tasks with `failed` status |

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
