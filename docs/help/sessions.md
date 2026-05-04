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

### Quality chips

When a session has been re-indexed under DERIVED_VERSION 5 (or scanned by the file-parse path), the row may surface up to three quality chips:

- **`NN% cache`** — cache hit ratio (`cache_read / (cache_read + cache_create)`). Green at ≥70% (cache paying back the build cost), amber under 50% (rebuilds dominating). Sessions with no cache activity at all simply don't show the chip.
- **`compaction loop`** (red) — at least one run of consecutive turn pairs where input variance was <10% and context fill was >75%. Signals Claude was burning tokens cycling on the same context without progress.
- **`tool fail streak`** (red) — at least one window of 5+ consecutive tool results where >50% errored. The first 6 turns are skipped to avoid early-session noise.

Click into a session to see the full breakdown on the **Diagnosis** tab.

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

### Diagnosis
Post-hoc 8-category quality analysis of the session, computed on demand from the JSONL:

- **Cache TTL expiry** — inter-turn gaps that exceeded the 5-minute prompt cache lifetime. Long pauses invalidate the cache; the rebuild on the next turn is paid in full.
- **Cache thrash** — three or more cache_creation spikes (≥5K tokens) within a 5-minute window. Usually means the system message or memory is mutating per turn (timestamps, listings) and forcing repeated rebuilds.
- **Context bloat** — at least one turn at >60% context fill. Suppressed when **near-compaction** would also fire so advice doesn't double up.
- **Near-compaction** — at least one turn at >83% fill, within striking distance of Claude Code's auto-compaction threshold.
- **Compaction loop** — same detector that drives the SessionsBrowser chip.
- **Tool failure streak** — same detector that drives the SessionsBrowser chip.
- **High idle** — total inter-turn idle time exceeds 30 minutes. Capped per gap at 12 hours so an overnight pause doesn't drown out genuine in-session idle.
- **Context-dominated** — ≥30% of assistant turns spent ≥10× more on input than on output. Pay-input-rates-for-repeat-context pattern.

The header strip surfaces outcome (completed / partial / abandoned / stuck), cache hit %, cache rebuild waste in dollars, peak fill, and total idle. The **Top advice** block ranks the three highest-impact fixes by estimated dollar impact.

This view is computed from JSONL on demand and does not require the SQLite index.
