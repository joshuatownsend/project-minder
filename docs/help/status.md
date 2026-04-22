# System Status

The **System Status** page (`/status`) gives you a live, cross-project view of every recent Claude Code session, grouped by what it's currently doing.

## Status buckets

| Status | Meaning |
|--------|---------|
| **Needs Approval** | Claude is paused waiting for a permission grant on a write-type tool (Edit, Write, MultiEdit, or NotebookEdit) and the file hasn't changed since the last check |
| **Working** | Claude is actively executing tools — Bash commands, web fetches, reads, etc. |
| **Waiting for You** | Claude finished its turn (`end_turn`) and is waiting for your next message |
| **Other / Stale** | Session is idle, abandoned, or in an unclassified state |

## How classification works

Project Minder reads the tail of each session's JSONL transcript every 3 seconds and applies a heuristic:

1. Find the last non-sidechain assistant turn.
2. Check whether all `tool_use` blocks from that turn have matching `tool_result` responses.
3. If all resolved and the turn ended naturally → **Waiting for You**.
4. If tools are still unresolved:
   - If the unresolved tool is a write-type (Edit/Write/MultiEdit/NotebookEdit) **and** the file mtime hasn't changed since the previous poll → **Needs Approval**.
   - Otherwise → **Working**.
5. If the file hasn't been touched in over 10 minutes → **Other / Stale**.

> **Note:** "Needs Approval" cannot be perfectly detected from JSONL alone — the permission prompt state lives in the Claude Code client. The heuristic biases toward write-type tools (which normally resolve in milliseconds) because a stalled write is far more likely to be a pending permission prompt than real work still executing.

## Worktree sessions

Sessions from Claude Code worktrees appear alongside main-project sessions, labeled with the worktree branch name. This lets you monitor multiple parallel Claude Code windows across different branches of the same project.

## Nav badge

The **Status** item in the top navigation shows a count badge when any session is in the **Needs Approval** bucket. The badge updates every 10 seconds.

## Coverage

The page covers all session files with mtime within the last 4 hours. Older sessions are not shown to keep the view focused on current activity.
