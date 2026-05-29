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

### Work-mode strip

Each session row shows a narrow colour-coded strip on the right summarising how the session's turns were classified:

| Colour | Mode | Includes |
|---|---|---|
| Green | Exploration | Exploration, Brainstorming, Planning |
| Amber | Building | Coding, Feature Dev, Refactoring |
| Red | Testing | Testing |
| Grey | Other | Git Ops, Build/Deploy, Debugging, Delegation, Conversation, General |

The strip is proportional to the percentage of assistant turns in each mode. Hover the strip for a tooltip with exact percentages. Sessions indexed before schema v10 (DERIVED_VERSION ≥ 7) will not show the strip.

### Quality chips

When a session has been re-indexed under the current `DERIVED_VERSION` (or scanned by the file-parse path), the row may surface up to five quality chips:

- **`NN% cache`** — cache hit ratio (`cache_read / (cache_read + cache_create)`). Green at ≥70% (cache paying back the build cost), amber under 50% (rebuilds dominating). Sessions with no cache activity at all simply don't show the chip.
- **`compaction loop`** (red) — at least one run of consecutive turn pairs where input variance was <10% and context fill was >75%. Signals Claude was burning tokens cycling on the same context without progress.
- **`tool fail streak`** (red) — at least one window of 5+ consecutive tool results where >50% errored. The first 6 turns are skipped to avoid early-session noise.
- **`resume anomaly`** (amber) — post-compaction output token spike detected. After a `compact_boundary` event, at least one assistant turn produced more than 10× the pre-boundary median output tokens — a known side-effect of the prompt cache bug present in CLI versions 2.1.69–2.1.89, or a context-confusion artefact in other versions.
- **`thinking`** (muted) — the session contains at least one extended thinking block from a Sonnet or Opus model.

Click into a session to see the full breakdown on the **Diagnosis** tab.

### PR chips

When a session ran `gh pr create` and the resulting PR URL appeared in the tool result, the session row on a project's **Sessions** tab shows a `PR #N` chip per PR (multiple if the session opened several). Chips are ordered by PR number ascending; the repo is derived from the URL itself (so PRs against a fork or sibling repo are attributed correctly, not against the session's git remote).

Clicking a `PR #N` chip filters the in-page session list to just sessions that created that PR — useful for "what other work touched this PR's slug-chain?" A filter banner appears above the list with an "open on GitHub" link and a clear-filter button. The filter is in-page only and does not change the URL.

Extraction happens at session-ingest time and matches the `gh pr create` Bash call to its `tool_result` by `tool_use_id` (not positional ordering), so parallel Bash dispatches can't cross-link results to the wrong call. Sessions written before this feature shipped backfill on the next reconcile via a DERIVED_VERSION bump.

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

### Session metadata panel

When Claude Code has recorded a per-session metadata file (`~/.claude/usage-data/session-meta/<id>.json`), a **Session metadata** panel appears below the stats strip. It surfaces Claude's own bookkeeping for the session that we don't otherwise compute: **git activity** (commits, pushes, lines added/removed, files modified), **interruptions**, the **capabilities** the session used (Task agent, MCP, web search, web fetch), and a breakdown of **tool errors by category**. Read-only; the panel is hidden when no record exists.

### Timeline
Chronological list of all events: user prompts, assistant responses, tool calls, thinking blocks, and errors. Each event shows a time offset from the session start. Assistant and user messages render **markdown formatting** — fenced code blocks appear in a monospace code box, and inline `code` spans are styled distinctly.

**Turn-duration badges** appear on assistant events when the session data includes `turn_duration` system entries — a wall-clock measurement Claude Code records at the end of each assistant turn. Durations format as `2.3s` for sub-minute turns and `4m12s` for longer ones.

**Tool call arguments** — click **show args** on any tool call row to expand the full arguments. Bash and PowerShell events show the command string; Read/Write/Glob events show the file path; Edit/MultiEdit events show an old→new inline diff; all other tools show a JSON pretty-print. Sessions indexed before schema v10 may not show tool arguments (requires `arguments_json` to be populated in the SQLite index).

**Thinking blocks** are collapsible. Click to expand an extended-thinking event and read the full reasoning trace (up to ~3000 characters). When the SQLite index is active (the default), thinking content is not stored in the database — it is fetched on demand from the original JSONL at the recorded byte offset. If the file has been moved or deleted, the block shows "Thinking content unavailable for this turn." rather than silently hiding the section.

**Replay scrubber** — a slider above the event list lets you scrub through the session as if rewinding a recording. Drag left to hide later events and see what the conversation looked like at any earlier point. The counter shows the current position (e.g. `47 / 184`). Click **Reset** to return to the full view. Pure client-side; no refetch required.

**Retry cycle highlights** — when the session contains Edit/Write → Bash(test) → re-Edit patterns (the structural signature of Claude trying, verifying, and retrying), each event within those cycles is highlighted with an amber left border. The scrubber bar also shows a count badge (e.g. `2 retry cycles`) when any are detected. This makes it easy to identify where Claude had to course-correct.

### Tools
Bar chart showing which tools were used and how many times.

### Files
Table of file operations (read, write, edit, glob, grep) with file paths and tool names.

### Subagents
Cards for each spawned subagent showing type, description, and top tools used.

### Orchestration
D3-powered DAG (directed acyclic graph) showing how subagents were spawned during the session. Each node is a spawned agent; edges show parent→child delegation. Node colors identify the agent type; hover for a tooltip with agent name and depth. Only appears when the session spawned at least one subagent (`subagentCount > 0`). Deep nesting beyond level 6 is collapsed into a `+N more` placeholder. Computed on demand from the original JSONL.

### Concurrency
Gantt-style timeline showing the main agent and each subagent as horizontal bars, positioned by wall-clock timestamps (falls back to turn-index proportions when timestamps are unavailable). Bar width represents active duration; bar label shows turn count. Hover a bar for `agentName · N turns`. A footnote appears when turn-index fallback is used. Only visible when the session has subagents.

### Delegation
Two-column Bezier flow diagram: primary models (left column) → subagent models (right column). Curve thickness scales with delegation count; curve opacity scales with token volume. Node height is proportional to total tokens routed through that model. Hover a curve for `ParentModel → ChildModel · N delegations · X.XK tokens`. Only visible when the session has subagents.

### Network
D3 force-directed graph of agent communication within the session. Each node represents a unique agent (collapsed across multiple invocations); node radius scales with message volume. Directed arrows show delegation edges. Hover a node for agent name and message count. A virtual `main` node anchors root-level delegations. Only visible when the session has subagents.

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

Two additional finding categories appear when relevant:
- **Buggy CLI version** (P1) — the session ran on CLI 2.1.69–2.1.89, a range with a known prompt-cache bug that causes cache rebuilds after compaction. Upgraded to P0 when a resume anomaly is also present.
- **Resume anomaly** (P1) — post-compaction output token spike detected (≥10× pre-boundary median). May indicate context confusion following `--resume` or `--continue` under a buggy CLI version.

**Tool errors by category** — below the findings, a strip of coloured chips shows how many tool errors occurred in each error category (permission, timeout, not-found, parse, network, interrupted, other). This section only appears when at least one tool call in the session errored.

This view is computed from JSONL on demand and does not require the SQLite index.

### Handoff

Structured mechanical extraction of everything that happened in the session, grouped into three columns:

- **Files Modified** — every file written, edited, or deleted (deduplicated, basename only for readability).
- **Git Commits** — commit messages extracted from `git commit -m` and HEREDOC forms. Basenames are parsed conservatively; when the message form is ambiguous the entry falls back to `<commit message unparsed>`.
- **Key Commands** — non-trivial Bash commands (length > 4 tokens, excluding common noisy one-liners).

When the session was auto-compacted by Claude Code, a **Compaction Fidelity** card appears below the columns. It scores what percentage of the mechanical facts above appear in the LLM-generated compaction summary. A score below 60% is flagged as **low fidelity** — the Size–Fidelity Paradox: the transcript was compressed but verifiable details were dropped. The card lists up to 10 missing facts so you can see exactly what was omitted.

Click **Generate handoff doc** in the Handoff tab header to open the handoff doc modal.

### Generate Handoff Doc

A copyable markdown brief for resuming the session, available at four verbosity levels:

| Level | Contents |
|---|---|
| **Minimal** | Original task + current state (500-char excerpt) + fact counts only |
| **Standard** | Minimal + last 10 turns + full fact lists (capped at 25 each) |
| **Verbose** | Standard extended to last 20 turns + uncapped facts + commit bodies + compaction fidelity callout |
| **Full** | Entire transcript + every fact + every commit body + per-tool call counts |

Use the **Copy** button to copy the markdown to your clipboard, or **Download .md** to save the file. Switching verbosity re-fetches the document immediately.

### Feedback

Available when Claude Code has recorded a qualitative self-rating for the session (stored in `~/.claude/usage-data/facets/<sessionId>.json`). Shows:

- **Underlying goal** — what Claude interpreted the task to be
- **Outcome** — how the session resolved (success, partial, blocked, etc.)
- **Helpfulness** — Claude's self-assessment of how helpful it was
- **Satisfaction** — user-satisfaction rating (if recorded)
- **Friction** — friction points and their counts
- **Summary** — one-sentence narrative summary

Not all sessions have feedback data. When absent, the Feedback tab shows "No feedback recorded for this session."
