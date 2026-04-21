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

## MCP Servers

If any MCP (Model Context Protocol) servers were used, their tool invocations are shown grouped by server name with per-tool counts.

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
