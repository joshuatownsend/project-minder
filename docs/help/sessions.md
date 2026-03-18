# Sessions Browser

The Sessions page shows all Claude Code sessions across your projects, parsed from `~/.claude/projects/` conversation logs.

## Session List

Each session card shows:
- **Project name** and initial prompt preview
- **Active indicator** — green pulse dot for sessions modified in the last 2 minutes
- **Duration** — how long the session lasted
- **Messages** — total message count
- **Tokens** — combined input/output token count
- **Tool calls** — total tool invocations
- **Subagents** — number of spawned subagents (if any)
- **Errors** — API error count (if any)
- **Git branch** — the branch active during the session
- **Model badges** — which Claude models were used

## Search & Sort

- **Search** — filter by prompt text, project name, session ID, or git branch
- **Sort** — by most recent, longest duration, or most tokens

## Session Detail

Click a session to see the full detail view with tabs:

### Timeline
Chronological list of all events: user prompts, assistant responses, tool calls, thinking blocks, and errors. Each event shows a time offset from the session start.

### Tools
Bar chart showing which tools were used and how many times.

### Files
Table of file operations (read, write, edit, glob, grep) with file paths and tool names.

### Subagents
Cards for each spawned subagent showing type, description, and top tools used.
