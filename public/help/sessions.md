# Sessions Browser

The Sessions page shows all Claude Code sessions across your projects, parsed from `~/.claude/projects/` conversation logs. The page polls every 15 seconds; session data is refreshed server-side every 30 seconds, so status changes appear within about 45 seconds.

## Session Status

Each session has a live status derived from the tail of its JSONL file:

| Status | Indicator | Meaning |
|---|---|---|
| **Working** | Green pulse dot | Claude is actively executing a tool call (file modified < 90s ago) |
| **Needs Attention** | Amber pulse dot | Claude sent a tool call and is waiting for a result (90s–10min old) |
| **Idle** | None | Session completed or abandoned |

The **Needs Attention** state is the key signal — it means Claude is at the keyboard waiting for you. Dashboard project cards show the most recent session's status badge when it is Working or Needs Attention.

## Session List

Each session card shows:
- **Status dot** — live Working / Needs Attention indicator (see above)
- **Project name** and prompt preview (or matched content snippet when searching)
- **Duration** — how long the session lasted
- **Messages** — total message count
- **Tokens** — combined input/output token count
- **Tool calls** — total tool invocations
- **Subagents** — number of spawned subagents (if any)
- **Errors** — API error count (if any)
- **Git branch** — the branch active during the session
- **Model badges** — which Claude models were used

## Search & Sort

- **Search** — filter by prompt text, **message body content** (full-text via SQLite FTS5 when the index is available), project name, session ID, slug, or git branch. When the match is in the message body rather than the prompt, the matched snippet is highlighted in the session row. A small **FTS** badge on the search input lights up while the FTS5 index is serving — when it's absent, you're seeing client-side filtering against the cached preview only.
- **Sort** — by most recent, longest duration, most tokens, or best one-shot rate

## Slugs and Continuations

Claude Code assigns each session a stable human-readable slug (e.g. `quirky-scribbling-plum`). When a session is `--resume`'d or `--continue`'d, the new session inherits the same slug while getting a new UUID — so we can group continuations into a single chain.

- A session row shows a small **continued** badge when it descends from a previous session in its slug chain. Hover for the predecessor's UUID.
- The slug chain orders strictly by start time; ties break on session ID for determinism.
- `/sessions/<slug>` resolves to the most recent session in the chain — useful as a stable bookmark that always points to the latest continuation.

Continuation linking requires the SQLite index. Under `MINDER_USE_DB=0` the slug still appears but the "continued" badge does not.

Note: a session created seconds before you visit `/sessions/<slug>` may 404 until the indexer's next sweep picks it up. Use the UUID URL (`/sessions/<sessionId>`) as a fallback during that window — UUIDs always resolve via direct file-parse even when un-indexed.

## Session Detail

Click a session to see the full detail view with tabs:

### Timeline
Chronological list of all events: user prompts, assistant responses, tool calls, thinking blocks, and errors. Each event shows a time offset from the session start. Assistant and user messages render **markdown formatting** — fenced code blocks appear in a monospace code box, and inline `code` spans are styled distinctly.

### Tools
Bar chart showing which tools were used and how many times.

### Files
Table of file operations (read, write, edit, glob, grep) with file paths and tool names.

### Subagents
Cards for each spawned subagent showing type, description, and top tools used.
