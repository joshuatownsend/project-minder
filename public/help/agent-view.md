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
- **+N sub-agent chip** — appears when one or more sub-agents are currently in flight (spawned but not yet finished). Requires [Live Activity](/settings/live-activity) hooks to be enabled.

Click or press **Enter** on a card to open the **Peek panel**.

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

## Peek panel

The Peek panel is a side drawer with two tabs:

- **Hook events** — the last 30 hook events for this session (last 5 minutes). Requires [Live Activity](/settings/live-activity).
- **Sub-agents** — a tree view of all sub-agent invocations recorded in the session's JSONL. Loaded lazily when you open the tab. Shows each sub-agent node with its depth, tool name, optional agent name, and completion status. Works for all sessions (no hooks required) but reflects the state as of the last JSONL index update.

## Running background sessions

Sessions launched with `claude --bg` in any terminal appear automatically in the **Working** or **Needs Input** columns. The filled process dot indicates the daemon confirmed the process is alive.

Sessions launched with `claude` (foreground) appear when either the Live Activity hook fires or the JSONL file updates within the last 90 seconds.

## Abandoned session reaper

Sessions that have been inactive longer than the **Abandon threshold** (default 180 minutes) automatically drop to **Stopped** so they don't clutter the board. You can adjust the threshold in Settings → Feature Flags → Agent View.

## Wave 3: What's new

**Live cost + context fill.** The cost chip and context-fill bar on each card are now populated in real time from the session's JSONL turns (not just historical data). Cost accumulates as Claude responds; the context bar turns amber above 50% fill and red above 85%. Only active sessions (Working, Waiting, Idle) show live cost — terminal sessions (Completed, Failed, Stopped) show the final total recorded at session end.

**Freshness clock.** The toolbar now displays "Updated Xs ago" next to the connection indicator, ticking every second between SSE events. It turns amber after 30 seconds of silence on a Live connection — a soft cue that the stream may be stalled rather than idle. The toolbar previously showed no indication of when the last event arrived.

**Catalog cross-reference in the Sub-agents tab.** Agent nodes in the tree that match an entry in your [Agents catalog](/agents) now render with the catalog entry's emoji and color, plus a link that pre-filters the catalog page to that agent. Click the ⓘ button next to any matched node to expand a one-line description inline without leaving the drawer.

**Insights tab in the peek panel.** The peek drawer now has a third tab — **Insights** — showing all `★ Insight` blocks written during this session. Sourced directly from the session JSONL (not INSIGHTS.md) so freshly-written insights appear within seconds of being produced. A count badge on the tab header lights up as soon as the first insight lands.
