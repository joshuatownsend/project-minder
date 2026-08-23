# Token Usage

The Usage dashboard provides detailed cost and token analytics for your Claude Code sessions across all projects.

## Overview

Navigate to **Usage** in the top navigation bar to view your token spending, cost breakdowns, and efficiency metrics.

## Period Filters

Use the period toggle at the top to filter data. Every option except **Today**
is a **rolling window** measured back from the moment you load the page — not a
calendar boundary:

- **24 hours** — the last 24 hours
- **Today** — since local midnight. The one calendar-aligned option, so it is
  the only one that shrinks to nothing just after midnight and grows through
  the day.
- **7 days** — the last 7×24 hours
- **30 days** — the last 30×24 hours
- **90 days** — the last 90×24 hours
- **1 year** — the last 365×24 hours
- **All time** — every recorded session, no lower bound

Because rolling windows move with the clock, the same period can report a
different total minutes later without you having done anything: work drops off
the trailing edge as it ages out. That is expected.

The **Cost report** (`/costs`) and each project's **Costs** tab offer the same
list minus **24 hours**, which is too granular to compare projects against.

Older links keep working: `?period=week` and `?period=month` are accepted as
aliases for **7 days** and **30 days** (and `quarter` / `year` for **90 days** /
**1 year**). These date from when the filters really were calendar-aligned —
"this week" started on Sunday and "this month" on the 1st. They now resolve to
the rolling equivalents, so a bookmarked link returns a slightly different span
than it did originally.

## Cost Accuracy

All cost estimates use per-model LiteLLM pricing (fetched from the LiteLLM pricing registry, cached for 24 hours) with built-in fallbacks for Opus, Sonnet, and Haiku. Cost numbers on the Usage page, Sessions list, and Stats page are computed from the same source and should match to within floating-point rounding.

**What's counted:**
- **Subagent (Task) spend is included.** Tokens and cost from subagent/sidechain turns fold into Total Cost, Total Tokens, and the by-model / by-project / daily / by-category breakdowns. Subagent turns are *not* counted toward tool stats, one-shot rate, or the activity heatmap (a subagent turn isn't a user-verified task or independent developer activity).
- **Long-context pricing is tiered.** For models with a published >200k surcharge, tokens above the 200k boundary are billed at the higher rate; shorter turns use the flat base rate.
- **Duplicates are removed.** A message that Claude Code re-logs (retry / resumed-session re-emit) is counted once, keyed by its message id.
- **Cache Hit Rate** is `cacheRead / (cacheRead + input + cacheWrite)` — cache-write tokens are in the denominator so the rate isn't overstated on cache-write-heavy sessions.

## Summary Cards

Four key metrics displayed at the top:
- **Total Cost** — estimated spend for the selected period (per-model pricing)
- **Total Tokens** — combined input and output tokens
- **Cache Hit Rate** — percentage of input tokens served from cache (higher is better, reduces cost)
- **One-Shot Rate** — percentage of code changes that passed verification on the first attempt (Edit → test → pass without re-editing)

## Compare (Period-over-Period)

Click **Compare** in the toolbar to overlay a delta strip above the summary cards, showing how the current period stacks up against the period immediately before it — last 7 days vs the 7 days before that, and so on. The same five metrics (cost, tokens, sessions, cache hit, one-shot rate) each gain a change indicator:

- **Volume metrics** (cost, tokens, sessions) show the relative change as a percentage, in a neutral tone — more or less activity is neither inherently good nor bad. A metric with no activity in the prior window is marked **new**.
- **Quality metrics** (cache hit, one-shot rate) show the change in *percentage points* and are colored green when improving, red when regressing.

The comparison always uses windows of **equal elapsed length**. For **Today** this means the current partial day is compared against the same number of hours ending at midnight — not against a full previous day — so the delta is honest first thing in the morning. Compare is unavailable for **All Time** (there is no earlier window to compare against) and requires the SQLite backend. It is also unavailable while the index is being read through for the first time — both windows would be partial, which makes the delta between them meaningless rather than merely imprecise.

## While the index is still building

The first time Minder reads your history through, it can only see the part it
has already ingested. Rather than showing you a total computed from a subset —
which would look exactly like a real total, only lower — the usage, sessions,
agents and skills pages fall back to reading your transcripts directly for the
duration of that first pass. The numbers are right; the pages are slower, and
they speed up once the pass finishes. Nothing is required of you.

If you have turned the indexer off entirely (`MINDER_INDEXER=0`), this does not
apply: nothing is going to build the index, so there is nothing to wait for.

One exception, and it is narrow. If you use a **non-Claude coding agent**
(Codex, Gemini) and Minder can find its sessions, the **Sessions** page keeps its
old behaviour during that window and may under-report, because reading
transcripts directly does not yet build session cards for non-Claude agents —
so swapping would trade an incomplete view of every agent for a complete view of
one. The usage, agents and skills pages no longer have this limitation: reading
transcripts directly now covers every agent you have enabled, so they swap like
everyone else.

Separately, the **Sessions** page reads every Claude home you have configured,
not just the default one — if a secondary or WSL home is missing from the list,
that is a bug rather than this behaviour.

## Daily Cost Chart

A bar chart showing daily spending across the selected period. Hover over bars to see exact cost, turn count, and token totals for each day. Days are bucketed by your **local** calendar date, so the daily bars, the "Today" total, and the contribution calendar all agree.

## Breakdown Charts

Charts breaking down costs by:
- **Model** — which Claude models consumed the most tokens (e.g., Opus vs Sonnet vs Haiku)
- **Project** — which projects cost the most (hidden when a project filter is active)
- **Category** — cost by activity type (see Activity Categories below)
- **Effort** — cost by reasoning effort, crossed with first-pass success (see below)

## By Effort

Claude Code records the reasoning effort of each assistant turn (`low`,
`medium`, `high`, `xhigh`). This panel shows what each level cost **and** how
often work started at that level passed verification first time — because
neither number means much alone. Cost by itself makes `xhigh` look like waste;
a success rate by itself ignores what the success cost. Side by side they
answer the actual question: does raising effort buy a better outcome, or just a
larger bill?

The rows are ordered by the effort scale, not by cost, so the trend reads
left-to-right and doesn't reshuffle when you change period.

**The `1-shot` column** counts *tasks*, not turns. A task is an edit followed by
a verification command (test, build, lint); it counts as one-shot when the
verification passed and no follow-up edit followed. Each task is attributed to
the effort of the turn that made the **edit** — the work being judged — not the
turn that ran the verification, which may differ.

**`—` is not `0%`.** An em-dash means no rate is being reported, for one of two
reasons. The **`n=` pill tells you which without hovering anything**:

- **No verified tasks** at that effort in the period — the row shows no pill at
  all. Nothing was measured. A genuine 0% would mean every attempt needed a
  retry, the opposite reading.
- **Too few verified tasks** (fewer than 30) for a percentage to mean anything
  — the row shows an amber pill such as `n=20`, the same low-confidence marker
  the Stats page uses on its OTEL cards.

Every row carries its `n=` sample count, suppressed or not, so the denominator
behind a rate is always visible.

Hovering a row's rate cell gives the same explanation in prose. That tooltip is
supplementary rather than load-bearing — mouse hover is unavailable on touch
and to keyboard users — so the distinction above is carried by the pill, and
screen readers are given the full sentence directly.

The threshold is a display rule only. `/api/usage`, the MCP tools and the CSV
export always report the true ratio whenever at least one task was measured, so
you can apply your own judgement to a thin bucket.

### Why a rate can be suppressed

On a real corpus the buckets are wildly uneven. In the author's history `high`
anchored 497 verified tasks while `xhigh` anchored 20 and `medium` 47. At 20
tasks, a 70% rate carries a 95% confidence interval of roughly 48–86% — wide
enough to overlap `high` entirely, so the two are statistically
indistinguishable even though the chart would draw them as a confident
14-point gap. Suppressing below 30 stops the panel asserting a difference its
sample can't support.

### Correlation, not causation

The panel says what happened at each effort level. It cannot say what the level
*caused*, and the difference matters because the confounding runs the wrong
way: higher effort is usually chosen for harder work. So a **lower** first-pass
rate at higher effort more likely reflects harder problems than worse output,
and reading the table as "xhigh is counterproductive" would be a mistake. A
caveat to this effect sits under the panel itself.

### The `unknown` bucket

Turns with no recorded effort are shown as `unknown`, greyed, and are never
folded into `medium`. Three different things land there:

- transcripts written before Claude Code ~2.1.212, when the field didn't exist;
- the small share of recent turns where Claude Code omits it;
- sessions indexed before Minder learned to read the field — these fill in
  automatically on the next re-index.

On a long history `unknown` is usually the largest bucket. If it is the *only*
bucket, the panel says so instead of drawing a single meaningless bar.

## By Entrypoint

Every session records how it was started, and the split is sharper than most
people expect:

| Entrypoint | Shown as | What it is |
|---|---|---|
| `cli` | Interactive | Started from a terminal — a person was there |
| `sdk-cli` | SDK (CLI) | Driven by a program through the CLI-based SDK |
| `sdk-py` | SDK (Python) | Driven by a program through the Python SDK |

The panel exists because pooling these makes every per-session average
meaningless. On the reference index, SDK-driven runs were **57.5% of sessions
but 3.4% of spend**, while interactive sessions were 41% of sessions and
**95.8% of spend** — $12.21 per session against $0.28, roughly a 44x
difference. An unsegmented "average cost per session" blends those into a
number that describes neither.

Your own split is whatever the panel shows. The shape — many cheap automated
runs, fewer expensive interactive ones — is the part that generalizes.

### Read the two percentages together

Each row shows its share of **sessions** and its share of **spend**, and they
rarely match. Automated runs are numerous and short; interactive sessions are
few and long. A bucket that is most of your sessions can be a minority of your
bill, and the reverse. Either number alone supports a confident wrong
conclusion, which is why the panel always shows both — along with the average
cost per session, which is the figure that actually compares like with like.

The rows keep a fixed order (interactive, then the SDK variants) rather than
sorting by cost, so the comparison holds its shape between periods.

### Background sessions

Claude Code flags some runs with `sessionKind: bg`. Minder treats this as a
**flag on top of** the entrypoint, not a separate row: a backgrounded
interactive session is still counted under Interactive, with its background
count noted in the row's tooltip. Folding it into the entrypoint axis would
quietly change what the Interactive row means.

This marker is rare — it appeared on 5 of 3,685 sessions in the reference
corpus — so its absence means "not flagged as a background run", not "unknown".

## What Caused the Spend

Claude Code records which **skill** and which **MCP server** is responsible for
each assistant turn's tokens. That is a different question from how often each
was *called*, and the gap is much larger than it sounds.

Measured on the reference index:

| | attributed cost | call-site estimate | ratio |
|---|---|---|---|
| MCP servers | $2,051.96 | $186.62 | **11x** |
| Skills | $2,441.87 | $6.54 | **373x** |

The reason is structural. The turn that *issues* a tool call is tiny — often a
single `tool_use` block. The expensive turn is the **next** one, which pulls a
large tool result into context and reasons over it. Counting call sites finds
the cheap turn and misses the costly one it caused. Skills show it most
starkly: call-site counting sees only the explicit `Skill` invocation, so a
skill like `pr-resolve` that then drives thousands of turns is nearly invisible
to it.

The gap is not a naming artifact. Restricting the comparison to the 13 servers
that appear under both signals still gives **10.6x**.

*The ratios above were measured before the tool-call indexing fix in #426, and
the call-site column is the side that was short: the index was storing only the
tool calls that arrived on the first line of an assistant message, which on the
reference corpus was roughly a quarter of them. **Expect these multiples to
shrink once your history re-indexes.** The direction of the finding does not
depend on the exact figure — attribution counts the expensive turn a tool call
causes, call sites count the cheap turn that issues it, and no correction to the
denominator changes which of those is larger. The numbers here are left as
measured, dated, rather than quietly adjusted to a value nobody has run.*

### "estimated" badge

Sessions recorded before Claude Code began emitting attribution have no
explicit signal, so those periods fall back to call-site inference and the
panel marks the list **estimated**. Treat an estimated figure as a floor rather
than a total. A list is always wholly one method or the other — mixing figures
that differ by 10x or more in one chart would be worse than showing either
alone.

An estimated figure counts a turn **once per target, not once per call**, so a
turn that calls the same server five times contributes its cost once. It also
covers primary turns only: subagent turns are excluded, because the tool calls
an estimate is built from are not indexed for them. Attributed figures are the
other way round — they include subagent turns, since a skill that delegates
still caused what the delegate spent.

### First-pass success per skill

Each skill also shows how often work started under it passed verification
without a follow-up edit, reusing the same task outcomes as the **By Effort**
panel. The same small-sample rule applies: below 30 verified tasks the rate is
suppressed and only the `n=` count is shown, because a skill sitting at "100%"
off two tasks is not evidence of anything.

### Which call inside a server

Each server row also names its costliest **tools**. A server total says
"Playwright cost $634"; it does not say what to do about it. The split does —
`browser_take_screenshot` returning an image costs far more per call than
`browser_click` returning nothing, so the breakdown turns a number into a
decision about which call to stop making. Shown only on attributed data:
there is no call-site equivalent worth trusting at this granularity, so an
estimated list omits it rather than guessing.

### The long tail

Skills and servers below 1% of attributed spend are folded into a single
"N more" row. The fold is shown rather than silently dropped, and its cost is
included in the total.

### On the Skills page

The skills catalog shows attributed spend alongside the invocation count, and
sorting by **Most expensive** is available there. The two columns answer
different questions and can disagree sharply: a skill invoked once that then
drives hours of work is expensive, and the invocation count alone says the
opposite. A skill with attributed spend but no recorded invocation still gets a
row — that combination is normal, not a glitch.

The agents catalog already reports cost from its own subagent sessions, which
is a more direct measure than attribution, so it is unchanged.

## Activity Categories

Each assistant turn is classified into one of 13 categories using deterministic rules:

| Category | What it detects |
|----------|----------------|
| Git Ops | git commands (commit, push, pull, merge, etc.) |
| Build/Deploy | build, deploy, docker commands |
| Testing | test runners (vitest, jest, pytest, etc.) |
| Debugging | bug/fix/error-related messages |
| Refactoring | refactor/rename/extract keywords |
| Delegation | Agent or Skill tool invocations |
| Planning | plan/design discussions without tool use |
| Brainstorming | idea generation without tool use |
| Exploration | read-only operations (Read, Grep, Glob) |
| Feature Dev | creating new files (Write tool) |
| Coding | editing existing files |
| Conversation | text-only exchanges |
| General | anything else |

## Tools & Shell Commands

Two charts showing:
- **Top Tools** — most-used Claude Code tools (Read, Edit, Bash, Write, etc.)
- **Shell Commands** — most-used CLI commands extracted from Bash/PowerShell invocations (git, npm, docker, etc.)

## Portfolio Yield

The **Portfolio Yield** section appears above the "By Project" breakdown when viewing aggregate data (no project filter active). It summarises how productive your Claude Code sessions have been across all projects, measured by correlating session time-windows with commits on each project's main branch.

- **Yield rate** — percentage of sessions that produced at least one non-reverted commit. Color-coded: green ≥ 70%, amber 40–70%, red < 40%.
- **Productive** — sessions that overlapped with one or more commits that were not subsequently reverted.
- **Reverted** — sessions whose commits were later reverted (standard `Revert "<subject>"` form).
- **Abandoned** — sessions with no matching commits in their time window.
- **Total sessions** — total sessions with enough data for yield classification.

The section is hidden when no projects have both session data and a detectable main branch (`main` or `master`). It only appears when you are not filtering by a single project — per-project yield is shown on that project's **Efficiency** tab instead.

### Per-project yield chips

In the **By Project** breakdown (toggle at the top of the section), each project row shows a small `NN%↑` yield chip when yield data is available. This lets you quickly compare productivity across projects.

> **Note:** Yield computation runs `git log` per project in parallel when you load `/usage`. On a large portfolio this may take a few seconds the first time. Subsequent loads within the same scan TTL (5 minutes) are instant.

## Activity Patterns

The **Activity** section surfaces temporal patterns across all of your recorded sessions. Unlike the summary cards and charts above, this section always covers full history — the period switcher (Today / Week / Month / All) doesn't apply. If a project filter is active, patterns are scoped to that project.

A caption below the section header reads "Streak, hourly, and heatmap use all sessions. Calendar shows the past 52 weeks. Period filter doesn't apply." as a reminder.

### Streak Cards

- **Current Streak** — how many consecutive calendar days you've had at least one Claude Code session, counting backward from today (or yesterday if today has no activity yet). Resets after a two-or-more day gap.
- **Longest Streak** — your all-time longest consecutive-day run, with a detail line showing your total number of active days.

### Hourly Distribution

A 24-bar chart showing turn volume by local hour of day. Use this to identify your peak working hours. Bars are colored with a 5-tier quantile scale so that relative intensity is visible even when one hour dominates.

### Day × Hour Heatmap

A 7×24 grid (rows = Sun→Sat, columns = 0–23) showing turn density at each day-of-week / hour-of-day combination. Quantile-binned coloring. Hover any cell for the exact turn count and cost.

### 52-Week Activity Calendar

A GitHub-style contribution calendar showing the past 52 weeks of activity. Oldest week is at the left; the current week is at the right. Month labels appear above the calendar when a new month begins. Hover any cell to see the date, turn count, and cost.

## Feedback

If Claude Code has recorded qualitative session feedback (stored in `~/.claude/usage-data/facets/`), the Feedback section shows cross-session distributions for:

- **Outcome** — how sessions resolved (success, partial, blocked, etc.)
- **Helpfulness** — Claude's self-assessed helpfulness rating
- **Satisfaction** — user-satisfaction distribution
- **Friction** — friction point types and their occurrence counts
- **Session type** — what kind of task each session was (coding, debugging, planning, etc.)

Each distribution is shown as a horizontal bar chart proportional to the maximum value in that category. The section header shows how many sessions contributed feedback data. The section is hidden when no feedback exists for the selected period and project filter.

## MCP Servers

If any MCP (Model Context Protocol) servers were used, their tool invocations are shown grouped by server name with per-tool counts.

## CLI Version History

A collapsible table at the bottom of the page showing which Claude Code CLI versions were used across the selected sessions. Columns: **Version**, **Sessions**, **First seen**, **Last seen**. Versions in the 2.1.69–2.1.89 range are tagged `buggy` — this range contains a known prompt-cache bug that causes cache rebuilds after compaction or resume. Click the "CLI Version History" header to expand the table.

## Project Filter

Use the **Filter** dropdown to scope all metrics to a single project. The "By Project" breakdown chart is hidden when a project filter is active.

## Export

Download your usage data:
- **Export CSV** — daily breakdown in spreadsheet-ready format
- **Export JSON** — full report data for programmatic analysis

## One-Shot Rate in Sessions

The Sessions browser also shows one-shot rate badges on individual session cards:
- 🟢 Green (≥80%) — excellent first-attempt success
- 🟡 Amber (50–79%) — moderate retry rate
- 🔴 Red (<50%) — frequent retries

Next to it, sessions that recorded reasoning effort show an **effort mix** chip
(e.g. `high×12 · xhigh×3`). The counts cover only turns that carried an
effort, so on an older session the chip's total is smaller than the session's
turn count — or absent entirely. The session detail page shows the same mix as
an **Effort** cell in its stat strip.
