# Agent View

Agent View is a real-time Kanban board showing all active Claude Code sessions across your projects. It lets you see at a glance which sessions need your input, which are actively working, and which have finished — without switching between terminal windows.

## The Kanban columns

| Column | Meaning |
|---|---|
| **Needs Input** | Session is waiting for your response (permission prompt, end-of-turn, or tool approval) |
| **Working** | Claude Code is actively running tools or computing a response |
| **Idle** | Session is open but has been quiet for a short period |
| **Completed** | Session ended cleanly (Stop or SessionEnd event) |
| **Failed** | Session exited with an error |
| **Stopped** | Session was stopped explicitly or timed out |

## Session cards

Each card shows:
- **Process dot** — filled circle: process confirmed running (from the daemon roster). Hollow ring: liveness inferred from JSONL file activity.
- **Project name** — which project the session belongs to.
- **Activity line** — last tool name or assistant excerpt.
- **Age** — how long ago the session last had activity.
- **Context chip** — appears when context fill exceeds 50%, turns red above 85%.
- **Cost chip** — estimated USD cost so far.

Click or press **Enter** on a card to open the **Peek panel**, which shows the last 30 hook events for that session. Hook events require [Live Activity](/settings/live-activity) to be enabled.

## Data sources

Agent View merges three sources, in priority order:

1. **Claude daemon roster** (`~/.claude/daemon/roster.json` + `~/.claude/jobs/*/state.json`) — ground-truth liveness for sessions launched with `claude --bg`. No setup required; the daemon dir won't exist if you haven't used background mode.
2. **Hook event ring** — precise event stream if you have Live Activity hooks installed (Settings → Live Activity).
3. **JSONL tail inference** — fallback for all sessions based on JSONL file mtime and last assistant turn.

## Filters and sort

Use the toolbar to:
- **Filter by status** — click one or more status chips to focus on a subset.
- **Filter by project** — narrow to one project.
- **Sort** by most-recent change, project name, or status group.

## Running background sessions

Sessions launched with `claude --bg` in any terminal appear automatically in the **Working** or **Needs Input** columns. The filled process dot indicates the daemon confirmed the process is alive.

Sessions launched with `claude` (foreground) appear when either the Live Activity hook fires or the JSONL file updates within the last 90 seconds.

## Abandoned session reaper

Sessions that have been inactive longer than the **Abandon threshold** (default 180 minutes) automatically drop to **Stopped** so they don't clutter the board. You can adjust the threshold in Settings → Feature Flags → Agent View.
