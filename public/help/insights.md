# Insights

The Insights feature extracts and preserves educational insight blocks from Claude Code conversation history.

## How It Works

When Claude Code generates insight blocks (marked with `★ Insight`, `✻`, `💡`, or `**Insight**` headers), they are extracted from conversation JSONL files and saved to `INSIGHTS.md` in each project root.

- **Append-only** — New insights are prepended (latest-first). Existing entries are never modified.
- **Deduplicated** — Each insight is hashed; duplicates are skipped automatically.
- **Persistent** — Insights survive even if conversation history is cleaned up.

## Cross-Project Browser

The `/insights` page shows all insights across your portfolio:

- **Search** — Filter by keyword across all insight content
- **Project filter** — Dropdown to scope to a single project
- **Session links** — Each insight links back to the originating session

## Per-Project Tab

Each project detail page has an **Insights** tab showing insights for that project only, with local search.

## Bootstrap Import

To import insights from existing conversation history:

```
npx tsx scripts/import-insights.ts
```

This scans all `~/.claude/projects/` JSONL files and writes `INSIGHTS.md` to each project that has insights. Safe to run multiple times.

## INSIGHTS.md Format

Insights are stored as markdown with HTML comment metadata:

```markdown
<!-- insight:abc123 | session:xxxxx | 2026-04-08 12:30:00 -->
## ★ Insight
[content]

---
```
