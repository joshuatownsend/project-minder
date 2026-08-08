# Stats Dashboard

The Stats page gives you a bird's-eye view of your entire development portfolio and Claude Code usage.

## Overview Cards

The top row shows key metrics at a glance:
- **Projects** — total scanned projects (with hidden count)
- **Claude Sessions** — total sessions across all projects
- **Pending TODOs** — outstanding items across all TODO.md files
- **Manual Steps** — pending manual steps across all projects
- **Est. Cost** — rough estimated cost of all Claude Code usage

## Claude Code Usage

Aggregated from conversation logs in `~/.claude/projects/`:
- **Token counts** — input, output, cache read/create tokens
- **Top Tools** — which tools Claude uses most (Read, Write, Edit, Bash, etc.)
- **Models** — which Claude models have been used
- **Errors** — API error count across all conversations

### Cross-check vs Claude's stats-cache

When Claude Code's own `~/.claude/stats-cache.json` is present, a small **Cross-check** card compares the totals we computed independently against Claude's own counter. Each row shows our number, Claude's number, and the **drift** (green under 5%, amber under 20%, red beyond). A large drift means our parser and Claude's bookkeeping disagree — a useful self-diagnostic. Both rows compare like-for-like counts: **Sessions** vs sessions, and our summed per-session **Messages** vs Claude's message tally. The card is hidden when the file is absent.

## Tech Stack Distribution

Bar charts showing how many projects use each:
- **Frameworks** — Next.js, Vite, Express, etc.
- **ORMs** — Drizzle, Prisma, etc.
- **Styling** — Tailwind, Sass, etc.
- **External Services** — Stripe, Clerk, Supabase, etc.

## Project Health

Segmented bars showing:
- **Status** — active vs paused vs archived distribution
- **Activity Recency** — when projects were last active (today, this week, this month, older)
- **TODO Completion** — completed vs pending across portfolio
- **Manual Steps** — completed vs pending across portfolio

## Session Complexity

Interactive scatter plot showing all Claude Code sessions across three configurable views:

- **Complexity vs Cost** — duration (log ms) vs cost (USD); dot size = tool count; color = session status
- **Context Pressure** — message count vs peak context fill; dot size = cost; color = compaction loop indicator
- **Reliability** — message count vs 1-shot rate; dot size = cost; color = tool failure streak indicator

Switch presets with the segmented control. Toggle **log x / log y** for long-tail distributions. Hover a dot for a tooltip; click to navigate to the full session detail page.

### Sessions that aren't plotted

Each preset needs one measurement to place a dot: duration for Complexity vs
Cost, peak context fill for Context Pressure, 1-shot rate for Reliability. A
session that never recorded it **is left off the chart**, and a line above the
plot says how many and which measurement they lack.

This matters more than it sounds. Those measurements are genuinely optional —
on the reference index 59% of sessions carry no peak context fill — and they
used to be substituted with `0`. That put a majority of the Context Pressure
cloud on the floor with tooltips reading `0% fill` as though measured, and on
Reliability it awarded the worst score on the chart to sessions nobody had
scored. A session measured *at* zero still plots at zero; only the unmeasured
ones are omitted.

If **no** session carries the measurement a preset needs — an older corpus, or
one where OTEL was never enabled — that preset says so instead of drawing an
empty chart. The other two presets may still have plenty; they use different
measurements.

## Telemetry

The section at the foot of the page — Edit Acceptance, Tool Latency, Token
Usage, Cache Efficiency, Hook Activity, Pressure, Permission Denials and Tool
Provenance — is documented under [OTEL telemetry](otel.md), along with the one
`today` / `7d` / `30d` / `all` toggle that governs all of them.

Two of those cards work with no telemetry configured at all: **Permission
Denials** reads transcript-ingest data, and **Hook Activity** falls back to
decoding session transcripts. The rest need OTEL enabled.
