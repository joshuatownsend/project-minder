# Token Usage

The Usage dashboard provides detailed cost and token analytics for your Claude Code sessions across all projects.

## Overview

Navigate to **Usage** in the top navigation bar to view your token spending, cost breakdowns, and efficiency metrics.

## Period Filters

Use the period toggle at the top to filter data:
- **Today** — activity from midnight today
- **This Week** — activity from the start of the current week (Sunday)
- **This Month** — activity from the 1st of the current month
- **All Time** — all recorded session data

## Cost Accuracy

All cost estimates use per-model LiteLLM pricing (fetched from the LiteLLM pricing registry, cached for 24 hours) with built-in fallbacks for Opus, Sonnet, and Haiku. Cost numbers on the Usage page, Sessions list, and Stats page are computed from the same source and should match to within floating-point rounding.

## Summary Cards

Four key metrics displayed at the top:
- **Total Cost** — estimated spend for the selected period (per-model pricing)
- **Total Tokens** — combined input and output tokens
- **Cache Hit Rate** — percentage of input tokens served from cache (higher is better, reduces cost)
- **One-Shot Rate** — percentage of code changes that passed verification on the first attempt (Edit → test → pass without re-editing)

## Daily Cost Chart

A bar chart showing daily spending across the selected period. Hover over bars to see exact cost, turn count, and token totals for each day.

## Breakdown Charts

Three side-by-side charts breaking down costs by:
- **Model** — which Claude models consumed the most tokens (e.g., Opus vs Sonnet vs Haiku)
- **Project** — which projects cost the most (hidden when a project filter is active)
- **Category** — cost by activity type (see Activity Categories below)

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

## Activity Patterns

The **Activity** section surfaces temporal patterns across all of your recorded sessions. Unlike the summary cards and charts above, this section always covers full history — the period switcher (Today / Week / Month / All) doesn't apply. If a project filter is active, patterns are scoped to that project.

A caption below the section header reads "Patterns based on all sessions; period filter doesn't apply" as a reminder.

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
