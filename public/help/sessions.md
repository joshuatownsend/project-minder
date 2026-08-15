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
- **Effort mix** — the reasoning-effort histogram for the session
  (e.g. `high×12 · xhigh×3`). Counts only turns that recorded an effort, so
  it is deliberately smaller than the turn count on older sessions and absent
  entirely on transcripts written before Claude Code ~2.1.212. See
  [Usage](usage.md) for how effort is crossed with first-pass success.

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

### Context tab

Shows **what actually filled the context window** during this session, broken into six sources: your prompts, attached context, Claude's replies, extended thinking, tool inputs, and tool output. A headline names the biggest contributor — e.g. *"Tool output accounted for 71% of the context this session put into the window."*

This is the retrospective counterpart to the context-overhead estimate on **Stats**, which tells you what your MCP servers, skills, and memory files cost *before* you type anything. Same subject, opposite direction.

- **Segmented at compaction.** When Claude compacts, the window is discarded and rebuilt, so the chart restarts rather than drawing a line straight through the reset. Each segment shows its own peak fill — this is how you find the moment a session hit the limit.
- **Per-turn strip.** Each bar is one turn, coloured by its largest contributor; red marks the first turn after a compaction. Spikes show you which single turn dumped 40k of file content into the window.
- **"Unattributed" is deliberate.** Total window size per turn is *measured* (Claude Code reports it), but the split is *estimated* from message sizes. The system prompt, tool definitions, CLAUDE.md, and skill bodies never appear in the transcript, so they can't be attributed — rather than quietly scaling the chart to 100%, that gap is shown as unattributed. If it's large, the Stats page tells you what's in it. The comparison is made *at the moment of peak fill*, not against the segment's running total: the peak measures the window as it was fed in, so anything produced after it — including that turn's own reply — was never part of it. Hover the segment for the exact figures.
- **Claude sessions only.** The tab appears for Claude Code sessions. Codex and Gemini transcripts live outside the directory this reads, so the tab is hidden rather than shown as a guaranteed error.
- **Attached context ≠ your prompts.** `<system-reminder>` blocks and `@`-mention file expansions arrive as user messages but you didn't type them, so they're counted separately.
- **Subagents are excluded.** They run in their own context window; their tokens still appear in cost totals.

### PR chips

The session row on a project's **Sessions** tab shows a `PR #N` chip for every PR the session opened (multiple if it opened several), ordered by PR number ascending.

Minder learns about a PR two different ways, and the chip's tooltip says which one it was:

| Source | How it's found | Reliability |
| --- | --- | --- |
| **recorded** | Claude Code writes a `pr-link` entry into the transcript | Authoritative — URL, number and repository are reported by the CLI |
| **scraped** | A PR URL matched by regex in `gh pr create` output | Inferred, including the repository, which is recovered from the URL |

**Both sources stay.** Recorded entries catch PRs opened by any route — the web UI, `gh pr create --web`, a script, or the GitHub API — which the scraper structurally cannot see, since no PR URL ever reaches the transcript text. But the scraper still catches PRs the CLI misses: measured across 5,319 local transcripts, recorded entries found 738 distinct PR URLs to the scraper's 657, and **5 URLs were found only by the scraper** — every one from a session that *did* record `pr-link` entries for its other PRs. That is a gap in the CLI's own recording rather than an artifact of old transcripts, so it will not disappear on its own.

When both sources see the same PR it appears once, labelled `recorded`, and the recorded repository wins over the one parsed back out of the URL.

Sessions indexed before this distinction existed show no source in the tooltip. That means "not recorded", **not** "scraped" — they re-populate on the next reconcile.

Clicking a `PR #N` chip filters the in-page session list to just sessions that created that PR — useful for "what other work touched this PR's slug-chain?" A filter banner appears above the list with an "open on GitHub" link and a clear-filter button. The filter is in-page only and does not change the URL.

Extraction happens at session-ingest time and matches the `gh pr create` Bash call to its `tool_result` by `tool_use_id` (not positional ordering), so parallel Bash dispatches can't cross-link results to the wrong call. Sessions written before this feature shipped backfill on the next reconcile via a DERIVED_VERSION bump.

Recent Claude Code versions also record PRs directly in the transcript, and Minder now reads those too, merging them with the scraped ones by URL. The recorded entry is more reliable: it survives truncated command output and catches PRs opened by any route — the GitHub web UI, `gh pr create --web`, or a script — not just ones whose `gh` output Minder could see.

### What Minder reads from newer transcripts

Claude Code 2.1.212 and later write extra detail into each session's transcript that Minder now decodes:

| Field | What it is |
|---|---|
| **Reasoning effort** | The effort level (`low`/`medium`/`high`/`xhigh`) each assistant turn ran at |
| **Fast mode** | Whether a turn used fast mode, which bills at a different rate |
| **Skill / MCP attribution** | Which skill or MCP server *caused* a turn's tokens — as opposed to merely which tools the turn called |
| **Session kind & entrypoint** | Whether a session ran in the background, and whether it was launched from the CLI or the SDK |
| **Session title** | Claude Code's own generated title for the session |
| **Permission modes** | Each switch between permission modes during the session |
| **Hook runs** | Which hooks ran and how long each took |

**These are absent on older sessions, and Minder keeps that distinction.** A session recorded before a field existed reads as *unknown*, never as a default — a session with no recorded effort is not a "medium effort" session, and one with no recorded permission-mode changes is not one that stayed in the default mode. Anywhere these appear, an unknown bucket is shown separately rather than folded into a real value.

*After upgrading, your history is re-indexed in the background to pick these up. Until that finishes, recent sessions have the new detail and older ones don't — nothing shown is wrong, there's just less of it.*

### Ticket chips

When a session **references** an issue tracker by a full URL — Linear (`linear.app/<workspace>/issue/<KEY>`), Jira (`<host>/browse/<KEY>`), or a GitHub issue (`github.com/<owner>/<repo>/issues/<N>`) — the session row shows a ticket chip per distinct ticket (e.g. `ENG-123`, `PROJ-45`, `owner/repo#42`). Clicking a chip filters the in-page list to sessions that reference that ticket, with the same banner + clear-filter affordance as the PR chips (selecting a ticket clears any active PR filter, and vice versa, so the two filters never combine into an empty list).

Unlike PR chips — which are tied to the *output* of a `gh pr create` command — a ticket reference is meaningful wherever it appears, so the extractor scans **all** session text (your prompts, Claude's replies, and tool output, including `gh issue create` results) for tracker URLs and dedupes by URL. There is no command pairing.

Scope: **full URLs only.** A full URL is self-validating — provider, key, and the canonical link all derive from the URL itself, so this is effectively false-positive-free. Bare keys (`ABC-123`, bare `#N`) in branch names or commit messages are deliberately *not* matched yet: they need per-workspace configuration to build a link and are more prone to false positives (e.g. `UTF-8`). Like PR chips, sessions written before this feature backfill on the next reconcile via a DERIVED_VERSION bump.

## Search & Sort

- **Search** — filter by **full message content** (full-text via SQLite FTS5 when the index is available), project name, session ID, slug, or git branch. Search reads whole messages, not just their opening lines: **extended thinking** and **subagent (Task) transcripts** are searchable too, so work Claude delegated to an agent turns up alongside everything else. **Tool inputs and outputs are deliberately not indexed** — command output and file dumps are the bulk of a transcript's size and the least useful thing to match on, and those files are on your disk anyway. Codex and Gemini sessions are indexed on their first ~500 characters only; those tools cap the text they expose before Minder sees it.
  When the match is in the message body rather than the prompt, the matched snippet is highlighted in the session row. A small **FTS** badge on the search input lights up while the FTS5 index is serving — when it's absent, you're seeing client-side filtering against the cached preview only.

  *After upgrading, search results fill in as your history is re-indexed in the background — you may see fewer body matches than usual until that finishes. Nothing returned in the meantime is wrong, there's just less of it.*
- **How results are ranked** — two searches actually run (three with semantic search enabled — see below): one keyword search over message text, and one over the "title" columns (slug, project name, git branch, first and last prompt). Their results are combined by **Reciprocal Rank Fusion**, which compares each session's *position* in the two lists rather than their raw scores — the two scoring systems aren't on a common scale, so comparing them directly would be meaningless. The practical effect: **a session that both searches find ranks above one that only a single search finds, even if that single match looked very strong.** Title matches carry somewhat more weight than body matches, since a hit on a slug or branch name is usually deliberate while a hit in a long transcript can be incidental.

  This ranking is what the **Relevance** sort orders by, and starting a search switches to it automatically. Picking any other sort (Recent, Longest, …) deliberately discards the ranking and orders by that field instead — so if you sort by Recent while searching, you get matches newest-first, not best-match-first. A sort you chose yourself is kept when you start searching; only the default Recent is swapped for Relevance.
- **Sort** — by relevance (while searching), most recent, longest duration, most tokens, or best one-shot rate. **Relevance appears only when the FTS index is serving** — without it (`MINDER_USE_DB=0`, or a failed search request) matching falls back to plain substring filtering, which produces no ranking to sort by.
- **Entrypoint** — narrows the list to sessions driven by one entrypoint: **Interactive** (`cli`, a person at a terminal), **SDK (CLI)** / **SDK (Python)** (a program), or **Unknown**. It appears only when the loaded sessions actually contain more than one, so a machine that has never run the SDK isn't offered a choice that can only return nothing.

  Worth using rather than ignoring, because the two populations barely resemble each other. On the reference index an interactive session costs **$13.43** against an SDK-driven session's **$0.22** — roughly **61×** — and the imbalance runs the other way by volume: **69%** of sessions are SDK-driven but they account for **4%** of the spend. Any figure averaged over the unfiltered list is describing a mixture that no individual session looks like. The same split, with costs, is on the **Entrypoint** panel of the [Usage](/help/usage) page and each project's Costs tab.

### Filters and search combine correctly

Filters (starred, source, entrypoint) are applied **inside the search query**, not to its results. This matters whenever a search matches a lot of sessions: search returns a ranked top slice, so filtering that slice afterwards could report **"no sessions"** for a filter that genuinely had matches — they just ranked below the cut. That is the failure this design avoids, and it is worth knowing about because the wrong answer looked exactly like a right one: an empty list, with no indication anything had been truncated.

The practical consequence is that a filter now changes **which** sessions the search ranks, so switching a filter re-runs the search rather than re-filtering what is already on screen. Counts under a filter can be trusted.

*(One caveat: without the FTS index — `MINDER_USE_DB=0`, or a failed search request — matching falls back to substring filtering over cached previews, which has no ranking and no cut, so the question does not arise.)*

### Semantic search (optional, off by default)

Keyword search only finds what you can spell. A session that says *"database migration error"* will not surface for the query *"the migration is failing"* unless the words happen to overlap. Semantic search adds a third retriever that matches on **meaning** instead of tokens, and feeds its ranking into the same Reciprocal Rank Fusion as the other two.

It is **off by default**, and turning it on is what consents to the setup cost:

| Cost | Detail |
|---|---|
| Model download | ~80 MB (`all-MiniLM-L6-v2`, ONNX) on first use, cached in `~/.minder/models/` |
| Backfill | Roughly **40 minutes** of background CPU to embed an existing corpus (measured at ~15 ms per chunk against ~157 000 chunks) |
| Disk | ~**58 MB** of vectors (384 bytes each), a ~7% increase on the index |
| Per query | ~**162 ms** for a full scan, with ~58 MB held in memory once the first semantic query runs |

#### Settings → Semantic Search

**Settings → Semantic Search** is where this is turned on and where the index gets built. The panel holds the feature toggle, a coverage bar (`embedded / total` chunks), a remaining-time estimate, and the build control.

Enabling the flag does **not** populate any vectors — it consents to the download, and the corpus still has to be embedded. Press **Build index** to start; the panel runs one bounded pass after another until the corpus is covered, showing passes completed and chunks embedded as it goes. **Stop after this pass** ends the run cleanly, and so does navigating away — the driver lives in the page, deliberately, so a forty-minute CPU spend is always something a visible window is doing rather than a background job you forgot about. It is fully resumable: everything embedded before a stop is kept, and the button becomes **Resume build**.

Because **newest chunks are embedded first**, recent sessions become searchable long before the pass completes — the coverage bar reaching 20% already means the last few weeks are covered.

At full coverage the button becomes **Verify index**, and it stays available rather than greying out. That is not cosmetic. A vector is keyed on `(session, turn, chunk)`, and a session that gets re-ingested with edited text can keep the same keys — so its old vectors still count as "embedded" and coverage still reads 100%, while the vectors now describe text that no longer exists. The check that catches this compares each vector against a hash of its source text, and it only runs as part of a backfill pass. Leaving the button live at 100% is what keeps that check reachable; without it, stale vectors would sit against new text and return confidently wrong results, which is worse than returning nothing. A verify pass that finds nothing says so.

#### Keeping the index current automatically

A built index goes stale the moment new sessions are indexed: those chunks have no vectors, so they are invisible to semantic search until someone presses Build again. The second toggle, **Keep the index current automatically**, closes that gap by topping the index up on the background task dispatcher's tick.

It is a separate switch from semantic search itself, and also defaults off, because it is a different kind of consent — the Build button spends CPU because you pressed it, this spends CPU with nobody watching. It does nothing unless semantic search is on, and the toggle says so rather than pretending to work.

What it does when enabled, on each ~30-second tick:

- **Only while the dispatcher is idle.** If any agent task is running, self-heal stands down entirely. It must never compete for CPU with the work the dispatcher exists to do.
- **About 250 chunks per pass** — roughly 3.8 seconds of CPU, a ~12% duty cycle. Sized for *drift*, not bulk: a few hundred chunks from newly indexed sessions clear in a tick or two. It would take hours to cover a cold corpus this way, which is the right speed for something nobody asked for in the moment — **Build index** remains the fast path.
- **Backs off by how likely the situation is to change.** Nothing to embed: quiet for ~10 minutes. A pass failed: ~20 minutes. No model, or no chunk corpus: ~1 hour, because those need an install or a migration and will not fix themselves on a short timer.
- **Never overlaps itself**, and never delays a tick — the pass runs detached, so task dispatch is not held up behind it.

Failures do not stay hidden. A self-heal pass that cannot load the model records the reason, which the panel then shows in place of *Runtime not loaded yet*.

Two states the panel is careful to distinguish, since both look like "unavailable" from the outside:

- *Runtime not loaded yet* — nothing has asked the model to load since the server started. This is the normal state after every restart, not a fault.
- *Runtime unavailable: …* — a real failure, with the reason attached (missing optional package, failed download, bad model output).

Likewise, a missing chunk corpus (schema v19) is reported as an index problem with its own remedy — restart so the migration runs — rather than being blamed on the model.

The same operations are available headlessly: `POST /api/embeddings`, optionally with a `{ "chunks": N }` budget, embeds one bounded batch and returns. `GET /api/embeddings` reports coverage, the model cache location, and whether the model is already on disk — all without triggering the download, so reading a progress bar can never be what starts an 80 MB fetch.

**Native build scripts are intentionally skipped.** `@huggingface/transformers` pulls `onnxruntime-node`, whose install script is not in this repo's `pnpm.onlyBuiltDependencies` allowlist, so `pnpm install` prints an "Ignored build scripts" warning. That is deliberate — the shipped prebuilt binary is sufficient, verified by running a full embed-and-search pass on an install where those scripts never ran. Adding a native postinstall to every install for a default-off feature would be the worse trade.

**What it degrades to.** Everything about this is optional. If the model package isn't installed, the download fails, the index is missing, or nothing has been embedded yet, the semantic retriever contributes an empty list — and an empty list contributes nothing to the fusion. Search silently becomes keyword-only rather than erroring. The same is true if the model errors mid-query.

**Requires the chunked search index.** Embeddings are built over the full-body chunk corpus (schema v19). On a database that hasn't been opened since that landed, the API says so explicitly rather than failing generically — restart Minder so the migration runs.

**Known limits, stated rather than discovered:**

- Chunk text is capped at 2 000 characters before embedding. `all-MiniLM-L6-v2` truncates at 256 word-piece tokens (~1 000 characters of English) regardless, so the tail of a long chunk was never going to reach the encoder. The back half of a very long chunk is not semantically indexed; the chunk overlap mitigates it.
- Vectors are re-checked against their source text. A session reparse recreates its chunk rows, and the `(session, turn, chunk)` key survives that — so each vector stores a hash of the text it was built from, and a mismatch drops it for re-embedding. Vectors whose session is gone are pruned too, rather than left to consume result slots in every scan.
- Vectors are stored as int8. That preserves ranking among meaningfully different results, but similarities within ~0.004 of each other may reorder — harmless, because fusion damps deep ranks heavily anyway.
- A session is scored by its **best** chunk, not an average. A long session with one highly relevant passage is exactly the result a semantic query is for.

## Slugs and Continuations

Claude Code assigns each session a stable human-readable slug (e.g. `quirky-scribbling-plum`). When a session is `--resume`'d or `--continue`'d, the new session inherits the same slug while getting a new UUID — so we can group continuations into a single chain.

- A session row shows a small **continued** badge when it descends from a previous session in its slug chain. Hover for the predecessor's UUID.
- The slug chain orders strictly by start time; ties break on session ID for determinism.
- `/sessions/<slug>` resolves to the most recent session in the chain — useful as a stable bookmark that always points to the latest continuation.

Continuation linking requires the SQLite index. Under `MINDER_USE_DB=0` the slug still appears but the "continued" badge does not.

Note: a session created seconds before you visit `/sessions/<slug>` may 404 until the indexer's next sweep picks it up. Use the UUID URL (`/sessions/<sessionId>`) as a fallback during that window — UUIDs always resolve via direct file-parse even when un-indexed.

## Session Detail

Click a session to see the full detail view with tabs:

### Titles and permission mode

The session row shows, in order:

1. **What matched your search**, when searching — an excerpt of the matched
   conversation text, or whichever of the title-slot fields matched (generated
   title, Claude Code's title, first prompt, last prompt, branch). A match on
   the **project name** or **branch** is shown by the row's own project and
   branch elements rather than in this slot; a match on a session id, slug or
   project path is not echoed back, since promoting an identifier or a file
   path here would be less useful than what it replaced.
2. **The latest recap**, if the session has one. A recap describes what
   happened while you were away, which is more useful on a row you're
   returning to than a title.
3. **A title** — one you asked Minder to generate, then Claude Code's own
   `ai-title`.
4. **The first prompt**, then the last prompt, then the git branch.

The detail header uses the same title preference (generated, then Claude
Code's, labelled **from Claude Code** so the two aren't confused). Claude Code
emits its title for free on about one session in ten; until recently that was
read, stored, and never shown, so the page offered to generate a title while
one sat unused.

**Both titles are searchable** under the `titles` scope. Neither used to be —
searching for the title displayed on a row returned nothing unless the same
words happened to appear in a prompt. Titles are session metadata rather than
turn text, so they are not in the full-text index and have to be matched
directly; on the reference corpus, 126 of 400 sampled sessions with a Claude
Code title are findable *only* by that field.

Sessions that switched permission mode carry a chip showing the path taken
(e.g. `plan → auto`), with consecutive repeats collapsed. A session that never
switched records no entry at all, so the chip is **absent rather than showing a
default** — no entry does not mean `auto`.

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

*Tool counts across the app — this table, the per-session tool breakdown, the
subagent count, and the tool charts on **Usage** — were undercounted before
#426. Claude Code writes one transcript line per content block, and the index
was keeping only the tools that landed on a message's first line; on the
reference history that was about a quarter of them, and most sessions recorded
none at all. **These fill in as your history re-indexes in the background.**
Until that finishes a session may show fewer tool calls than it made — nothing
shown is wrong, there is just less of it.*

### Subagents
Cards for each spawned subagent showing type, description, and top tools used.

A card whose details came from Claude Code's own `agent-*.meta.json` record —
rather than being inferred from the parent transcript's Agent tool call — says
so, and shows the turn count from that record.

A **disagreement** between that count and one derived from the transcript turns
the chip amber and shows both, rather than picking one. This requires two real
counts: with the SQLite index active (the default) subagent transcripts are not
indexed, so there is no independent count and none is claimed. A card there
reads `14 turns recorded`, not `14 turns recorded · 0 counted` — a backend that
cannot count is not a backend that counted zero.

### Hooks
What hooks cost this session. Runs are grouped by command and ranked by **total
measured time** — not by how often each fired, since the question here is where
the session's wall-clock actually went. Each row shows runs, total, p50 and max.

A run Claude Code did not time counts toward the run count but is excluded from
every duration: the row reads `12 (9 timed)` and shows `—` rather than `0ms`,
because an untimed hook is not an instant one. The header states the session
total and how many runs went untimed.

Hook **failures** are listed below the table when present, with a blocking
failure (it stopped the turn) styled distinctly from an advisory one. Failures
carry no command — the underlying data cannot attribute them to a specific hook.

The tab appears only for sessions that recorded at least one hook run or
failure, and works on both storage backends. See [Hooks](hooks.md) for the
cross-session view.

### Orchestration
D3-powered DAG (directed acyclic graph) showing how subagents were spawned during the session. Each node is a spawned agent; edges show parent→child delegation. Node colors identify the agent type; hover for a tooltip with agent name and depth. Only appears when the session spawned at least one subagent (`subagentCount > 0`). Deep nesting beyond level 6 is collapsed into a `+N more` placeholder. Computed on demand from the original JSONL.

### Concurrency
Gantt-style timeline showing the main agent and each subagent as horizontal bars, positioned by wall-clock timestamps (falls back to turn-index proportions when timestamps are unavailable). Bar width represents active duration; bar label shows turn count. Hover a bar for `agentName · N turns`. A footnote appears when turn-index fallback is used. Only visible when the session has subagents.

### Delegation
Two-column Bezier flow diagram: primary models (left column) → subagent models (right column). Curve thickness scales with delegation count; curve opacity scales with token volume. Node height is proportional to total tokens routed through that model. Hover a curve for `ParentModel → ChildModel · N delegations · X.XK tokens`. Only visible when the session has subagents.

### Network
D3 force-directed graph of agent communication within the session. Each node represents a unique agent (collapsed across multiple invocations); node radius scales with message volume. Directed arrows show delegation edges. Hover a node for agent name and message count. A virtual `main` node anchors root-level delegations. Only visible when the session has subagents.

### Diagnosis
Post-hoc 9-category quality analysis of the session, computed on demand from the JSONL:

- **Cache TTL expiry** — inter-turn gaps that exceeded the 5-minute prompt cache lifetime. Long pauses invalidate the cache; the rebuild on the next turn is paid in full.
- **Cache thrash** — three or more cache_creation spikes (≥5K tokens) within a 5-minute window. Usually means the system message or memory is mutating per turn (timestamps, listings) and forcing repeated rebuilds.
- **Context bloat** — at least one turn at >60% context fill. Suppressed when **near-compaction** would also fire so advice doesn't double up.
- **Near-compaction** — at least one turn at >83% fill, within striking distance of Claude Code's auto-compaction threshold.
- **Compaction loop** — same detector that drives the SessionsBrowser chip.
- **Tool failure streak** — same detector that drives the SessionsBrowser chip.
- **Stuck loop** (P1, P0 at ≥5 repeats) — the same tool was called 3+ times in a row with identical input *and* identical output. The strongest "not making progress" signal: distinct from the tool-failure streak (where errors vary) and the one-shot retry cycle (where inputs change). Forces the session outcome to **stuck**.
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

### Export as Markdown

The **Export** button in the session header renders the whole conversation as one self-contained markdown file — front matter, headings per message, collapsible thinking and tool results. A large session (tens of MB of JSONL) typically lands in the low hundreds of KB, which is small enough to paste into an issue, commit into a repo, or hand to another model.

This is a different thing from **Generate handoff doc** above. The handoff doc is a *brief* — extracted facts plus a tail of turns, written for resuming work. The export is the *transcript*.

Choose a detail level:

| Level | Contents |
|---|---|
| **Minimal** | Prompts and replies only. No tool calls, no results, no thinking. |
| **Standard** *(default)* | Adds tool calls and tool results, with results truncated to 1,500 characters each. |
| **Full** | Everything: extended thinking, subagent messages, tool results up to 8,000 characters, and uncapped message text. |

An **Include extended thinking** checkbox appears when the session has thinking blocks, so you can add them to a Standard export (or drop them from a Full one) without changing level.

**Download .md** saves the file; **Copy** puts the markdown on your clipboard. Either way a toast reports what you got — message count, file size, and how many blocks were truncated.

#### Where the text comes from

The export reads the session's original JSONL, not Project Minder's index. That matters: the index stores each turn as a *preview* (a few hundred characters) because it exists to render lists and feed search. An export built from it would silently cut every long message mid-sentence.

When the JSONL is unavailable — pruned by Claude Code's own retention, synced from another machine, over 50 MB, or in demo mode — the export still works, but falls back to the index and says so in two places: `fidelity: "index"` in the front matter, and a warning callout at the top of the document. Message bodies in that mode are cut off at the source, not by the detail level.

#### Notes

- Everything the detail level leaves out is counted in an **Export notes** line at the bottom of the document. Nothing is dropped silently — including messages that rendered nothing at the chosen level, subagent messages excluded, and anything beyond the reader's 20,000-message cap.
- **Codex and Gemini sessions export from their own transcripts too.** The file is located through the session's adapter rather than Claude's `projects/<dir>/<id>.jsonl` layout, which those sessions never matched — so they used to fall back to index previews even though the raw transcript was on disk.
- **Subagent transcripts are read from their own files.** Modern Claude Code keeps them at `<project>/<session-id>/subagents/agent-*.jsonl` rather than inline in the parent session, so `Full` (or `sidechains=1`) opens those too and appends them, tagged `(subagent)`. They are appended rather than interleaved: the files carry independent timelines, and merging by timestamp would imply an ordering across processes the data doesn't support.
- **Re-emitted assistant messages are collapsed.** Claude Code re-logs a message on a retry or a resumed session; the export dedupes by `message.id` (falling back to `requestId`), the same rule the usage parser uses.
- **Image attachments** are noted in place rather than dropped — markdown can't carry them, but a prompt shouldn't lose half its content invisibly.
- An **API error longer than 2,000 characters** gets a short callout plus the full text in a fenced block below, so `Full` really is full.
- Code fences in the transcript are handled: a tool result containing ` ``` ` is wrapped in a longer fence so the block doesn't close early and turn the rest of the file into prose.
- Front matter values are quoted, so Windows paths and project names containing `:` or `#` stay valid YAML.
- The endpoint is `GET /api/sessions/<id>/export`. Add `?format=json` for `{ markdown, stats, fidelity }`, or `?download=1` for an attachment `Content-Disposition`. Query params `detail`, `thinking`, `tools`, `results`, and `sidechains` mirror the modal's controls.

### Feedback

Available when Claude Code has recorded a qualitative self-rating for the session (stored in `~/.claude/usage-data/facets/<sessionId>.json`). Shows:

- **Underlying goal** — what Claude interpreted the task to be
- **Outcome** — how the session resolved (success, partial, blocked, etc.)
- **Helpfulness** — Claude's self-assessment of how helpful it was
- **Satisfaction** — user-satisfaction rating (if recorded)
- **Friction** — friction points and their counts
- **Summary** — one-sentence narrative summary

Not all sessions have feedback data. When absent, the Feedback tab shows "No feedback recorded for this session."


## Delegation cap warnings

Claude Code enforces hard per-session limits on delegation — 200 subagent
spawns, 200 web searches, 20 concurrent subagents, and a spawn depth of 3. These
are a genuinely new failure mode: a session that hits one is **silently
truncated** rather than finishing. Nothing in the transcript says "I stopped
because I ran out of subagents"; the work just stops, and the session reads like
one that chose to finish.

A session at or near a cap gets a warning chip on its row. Sessions comfortably
inside the limits get nothing — a badge on every session that used a handful of
subagents is noise, and noise is how a real one gets missed.

**Counts cover the whole session tree.** A subagent that spawns its own agents
or runs its own searches spends the same per-session budget, so the chip counts
the root session plus every subagent transcript below it. Before #395 it counted
only the root's own calls, which meant the chip was silent in precisely the
runaway-delegation case it exists to warn about — locally, three quarters of all
web searches were being made inside subagents and none of them were counted.

This is deliberately *not* what the **Subagents** count or the tool tables on
**Usage** show; those still mean "calls this session made itself", which is what
per-session cost and tool reporting is built on.

**The chip needs a re-derived index.** The tree can only be reconstructed from
data written by a current version of the indexer, so until your history
re-indexes — and until every subagent transcript belonging to a session has been
re-indexed too — the cap is reported as unmeasured and no chip appears. A
partial count is worse than no count here: it would understate by exactly the
nested work the chip exists to surface. For the same reason the chip does not
appear at all with `MINDER_USE_DB=0`, which reads transcripts directly and never
opens the `subagents/` directory.

A subagent transcript that was never indexed is invisible to the count, so the
number can read low. It cannot read high.

The chip says a cap was **reached**, never that anything was *blocked*. Two of
the caps are configurable (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`,
`--max-budget-usd`), so Minder can see the count but not the ceiling actually in
force on your machine.

**Only web *searches* count toward the search cap.** `WebFetch` is a different
tool with no documented quota; counting it would label a session with 160
fetches and no searches as nearing a cap it is nowhere near.

**Concurrency and depth are not measured.** Concurrency is an instantaneous
property a finished transcript cannot recover. Depth needs parent-to-child
linkage between individual spawns, which the transcripts do not carry — the
session-to-session linkage added in #395 is enough to find every transcript
below a session, but not to tell which of them spawned which, because Claude
Code files them all flat under the root session's directory. They are reported
as unmeasured rather than as zero — showing `0` would render a session nested
five deep as comfortably inside a cap of three.
