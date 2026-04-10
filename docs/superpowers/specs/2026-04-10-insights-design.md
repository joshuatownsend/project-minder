# Insights Feature — Design Spec

**Date:** 2026-04-10
**Branch:** feature/insights

## Overview

Extract and preserve Claude Code's `★ Insight` blocks from conversation history. Hybrid approach: insights are extracted from JSONL conversation files and appended to per-project `INSIGHTS.md` files (append-only, latest-first). A one-time bootstrap script imports all existing insights; subsequent scans append incrementally.

## Data Model

New types in `src/lib/types.ts`:

```ts
interface InsightEntry {
  id: string;              // hash of content for dedup
  content: string;         // the insight text (between markers)
  sessionId: string;       // which conversation it came from
  date: string;            // timestamp from the JSONL entry
  project: string;         // project slug
  projectPath: string;     // full path
}

interface InsightsInfo {
  entries: InsightEntry[];
  total: number;
}
```

`ProjectData` gains: `insights?: InsightsInfo`

## Insight Extraction (Parser)

**File:** `src/lib/scanner/insightsMd.ts`

### `parseInsightsFromJsonl(content: string, sessionId: string): InsightEntry[]`

Scans JSONL conversation content for insight blocks inside `assistant` message `text` blocks. Matches the broad marker set from the gist:

- `` `★ Insight` `` with trailing dashes
- `` `✻ Insight` `` with trailing dashes
- `💡` marker
- `**Insight**`
- `## Insight`

Captures everything between the opening marker line and the closing line (backtick + dashes/underscores) or a blank line. Returns `InsightEntry[]` with content, sessionId, and timestamp from the enclosing JSONL entry.

### `parseInsightsMd(content: string): InsightsInfo`

Reads an existing `INSIGHTS.md` file. File format (latest-first):

```markdown
<!-- insight:abc123 | session:xxxxx | 2026-04-08 -->
## ★ Insight
[content lines]

---

<!-- insight:def456 | session:yyyyy | 2026-04-07 -->
## ★ Insight
[content lines]

---
```

HTML comments hold dedup ID, session ID, and date — invisible when rendered, parseable by the scanner.

### `scanInsightsMd(projectPath: string): Promise<InsightsInfo | undefined>`

Reads `INSIGHTS.md` from project root, returns `InsightsInfo`. Used by scanner orchestrator.

## Append Logic

**File:** `src/lib/insightsWriter.ts`

### `appendInsights(projectPath: string, entries: InsightEntry[]): Promise<number>`

1. Reads existing `INSIGHTS.md` (or starts empty)
2. Extracts existing IDs from HTML comments
3. Filters out duplicates
4. Prepends new entries at the top (latest-first)
5. Writes back
6. Returns count of newly appended entries

## Bootstrap Script

**File:** `scripts/import-insights.ts`
**Run:** `npx tsx scripts/import-insights.ts`

1. Scans all project dirs in `~/.claude/projects/*/`
2. Decodes dir names to project paths (e.g. `C--dev-project-minder` → `C:\dev\project-minder`)
3. Reads every JSONL file, extracts insights via `parseInsightsFromJsonl`
4. Groups by project, calls `appendInsights` for each
5. Prints summary per project
6. Only writes to projects that exist on disk
7. Idempotent — safe to run multiple times (dedup IDs)

## Incremental Append (Runtime)

During the normal scan cycle (5-min cache TTL), the scanner:
1. Reads JSONL files for each project
2. Extracts insights not yet in `INSIGHTS.md`
3. Appends new ones via `insightsWriter`

This piggybacks on existing scan infrastructure — no new background processes.

## API Routes

### `GET /api/insights`

All insights across all projects.

Query params:
- `?project=slug` — filter to one project
- `?q=searchterm` — keyword search across content

Response: `{ insights: InsightEntry[], total: number }`

### `GET /api/insights/[slug]`

Insights for a single project. Same response shape.

Read-only — no POST/PUT needed.

## UI Components

### Cross-Project Page: `/insights`

**Route:** `src/app/insights/page.tsx`
**Component:** `InsightsBrowser`

- Follows `SessionsBrowser` pattern
- Search bar (keyword search across all insight content)
- Project filter dropdown
- Date sort (latest-first default)
- Insight cards show: project name (linked), date, content, session link
- Nav link in `layout.tsx` alongside Sessions and Stats

### Per-Project Tab

New "Insights" tab in `ProjectDetail.tsx`:
- `InsightsTab` component
- Fetches `/api/insights/[slug]`
- List of insight cards, latest-first
- Search within project insights
- Links to originating session

### Dashboard Card Indicator

Subtle indicator on `ProjectCard` showing insight count (like the amber git `+N` badge). Only visible when insights exist.

### Help Docs

Update `/docs/help/` with insights documentation per documentation policy.

## Scanner Integration

`src/lib/scanner/index.ts` adds `scanInsightsMd` to the parallel scan array, same as `manualStepsMd`. The result populates `ProjectData.insights`.

## Files to Create

- `src/lib/scanner/insightsMd.ts` — parser (JSONL extraction + INSIGHTS.md reading)
- `src/lib/insightsWriter.ts` — append logic
- `scripts/import-insights.ts` — bootstrap script
- `src/app/api/insights/route.ts` — cross-project API
- `src/app/api/insights/[slug]/route.ts` — per-project API
- `src/app/insights/page.tsx` — cross-project page
- `src/components/InsightsBrowser.tsx` — cross-project browser
- `src/components/InsightsTab.tsx` — per-project tab
- `docs/help/insights.md` + `public/help/insights.md` — help docs

## Files to Modify

- `src/lib/types.ts` — add `InsightEntry`, `InsightsInfo`, extend `ProjectData`
- `src/lib/scanner/index.ts` — add `scanInsightsMd` to parallel scan
- `src/app/layout.tsx` — add Insights nav link
- `src/components/ProjectDetail.tsx` — add Insights tab
- `src/components/ProjectCard.tsx` — add insight count badge
- `src/lib/help-mapping.ts` — add `/insights` route mapping
- `CHANGELOG.md` — document the feature
