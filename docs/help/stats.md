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
