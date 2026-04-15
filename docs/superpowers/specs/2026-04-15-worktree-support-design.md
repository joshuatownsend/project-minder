# Worktree Support Design

**Date:** 2026-04-15  
**Branch:** feature/worktree-support  
**Status:** Approved

## Problem

Project Minder already discovers Claude Code worktrees (`--claude-worktrees-` naming convention) and surfaces their markdown files as read-only overlays. Three gaps remain:

1. **Dev server**: Running the dev server from a worktree requires the user to manually `cd` there and start it. Project Minder has no awareness of worktree dev servers.
2. **Markdown file conflicts**: TODO.md, INSIGHTS.md, and MANUAL_STEPS.md are written independently in worktrees and can conflict on merge. No tooling exists to pre-sync these before merging.
3. **Stale worktrees**: After a branch is merged and the PR closed, the local worktree directory persists. Users have no visibility into stale worktrees and no in-app cleanup path.

## Approach

**Option B — Separate worktree status API (chosen)**

Keep `WorktreeOverlay` lean. Add a new on-demand `/api/worktrees/[slug]` route that runs git checks lazily when the user expands a worktree section. Dev server control reuses the existing `processManager` with a worktree-specific slug convention. This mirrors the existing `gitStatusCache` pattern and keeps the main scan fast.

Rejected alternatives:
- **Option A** (fat `WorktreeOverlay`): Couples slow git network ops to the main scan path.
- **Option C** (background polling cache): More complexity before knowing usage patterns; can be added later as an optimization.

## Data Model

### New type: `WorktreeStatus` (add to `src/lib/types.ts`)

```ts
interface WorktreeStatus {
  worktreePath: string;
  branch: string;
  isDirty: boolean;
  uncommittedCount: number;
  isMergedLocally: boolean;       // git branch --merged main
  isRemoteBranchDeleted: boolean; // git ls-remote --heads origin <branch> returns empty
  isStale: boolean;               // true when isMergedLocally && isRemoteBranchDeleted
  lastCommitDate?: string;
  devServer?: DevServerInfo;      // injected from processManager if a server is running
}
```

### `WorktreeOverlay` — no changes

The existing type (`branch`, `worktreePath`, `todos`, `manualSteps`, `insights`) stays as-is. `WorktreeStatus` is fetched separately on demand.

## API Routes

### `GET /api/worktrees/[slug]`

Returns `WorktreeStatus[]` for all worktrees attached to the given project slug.

Per worktree, runs in parallel:
- `git branch --merged main` (from parent project path) → `isMergedLocally`
- `git ls-remote --heads origin <branch>` → `isRemoteBranchDeleted` (empty output = deleted)
- `git status --porcelain` (in worktree path) → `isDirty`, `uncommittedCount`
- `git log -1 --format=%aI` (in worktree path) → `lastCommitDate`

Injects live `processManager.get(worktreeSlug)` as `devServer` if present.

**Offline/timeout handling:** If `git ls-remote` times out or fails, `isRemoteBranchDeleted` defaults to `false` and `isStale` stays `false` — no false positives when offline.

### `POST /api/worktrees/[slug]`

Body actions:

**`start-server`**
```json
{ "action": "start-server", "worktreePath": "/abs/path", "port": null }
```
- Slug convention: `{parentSlug}:wt:{branchHint}` (e.g. `project-minder:wt:feature-worktree-support`)
- Port auto-find: start at `parentDevPort + 1`, increment via existing `isPortInUse()`, cap at 10 attempts
- Delegates to `processManager.start(worktreeSlug, worktreePath, resolvedPort)`

**`remove`**
```json
{ "action": "remove", "worktreePath": "/abs/path" }
```
- Only permitted when `isStale: true` (enforced server-side)
- Runs `git worktree remove <worktreePath>` from parent project path
- If git refuses (uncommitted changes), returns 409 with git's error message — never force-removes

### `POST /api/worktrees/[slug]/sync`

```json
{ "worktreePath": "/abs/path", "file": "todos" | "manual-steps" | "insights" }
```

Reads both the parent file and worktree file. Diffs entries:
- **Insights**: by `InsightEntry.id` (content hash, already used)
- **TODOs**: by item text
- **Manual steps**: by entry header (`## date | slug | title`)

Appends worktree-only entries to the parent file using existing writers (`todoWriter`, `manualStepsWriter`, `insightsWriter`). Append-only — never overwrites or reorders existing parent content.

## UI

### `WorktreePanel` component (replaces `WorktreeSection`)

Location: project detail page, shown per-worktree when the project has `worktrees`.

**Loading**: Fetches `/api/worktrees/[slug]` on first expand (lazy). Shows skeleton while loading.

**Per worktree row:**

- Branch name badge (monospace) + last commit date
- **Dev server**: compact `DevServerControl` reused with worktree slug and `projectPath = worktreePath`. Shows `● :4101` when running, Start button when stopped, `localhost:4101` link when running.
- **Sync indicators**: per-file badges for TODO, Manual Steps, Insights. Each shows "out of sync" (amber) when worktree has entries not in parent, "in sync" (green) after sync. Each has a "Sync to parent" button.
- **Staleness**: amber "Stale" badge when `isStale: true`. "Remove worktree" button opens confirmation modal showing branch, last commit date, and uncommitted count (safety check even though stale implies 0). Confirmed action calls `POST /api/worktrees/[slug]` `remove`.

**Error states:**
- Status fetch failure → inline retry button
- Sync error → inline error next to badge
- Remove error → shown in confirmation modal (e.g. git refused due to uncommitted changes)

### Project card additions (minimal)

- Blue `wt` dot alongside dev server badge if any worktree server is running
- Amber `N stale` badge if any worktrees are stale (count)

These are additive — no changes to existing card layout.

### No new page

All worktree management lives in the existing project detail view. The worktree section is already rendered in `ProjectDetail.tsx`.

## File Changes

| File | Change |
|------|--------|
| `src/lib/types.ts` | Add `WorktreeStatus` interface |
| `src/app/api/worktrees/[slug]/route.ts` | New: GET + POST handlers |
| `src/app/api/worktrees/[slug]/sync/route.ts` | New: POST sync handler |
| `src/components/WorktreePanel.tsx` | New: management UI (dev server, sync, staleness) for Overview tab |
| `src/components/WorktreeSection.tsx` | No changes — stays as collapsible content display in TODO/Manual Steps/Insights tabs |
| `src/components/ProjectDetail.tsx` | Wire `WorktreePanel` into Overview tab |
| `src/components/ProjectCard.tsx` | Add `wt` dot + stale badge |
| `src/lib/scanner/worktrees.ts` | No changes needed |
| `src/lib/processManager.ts` | No changes needed (worktree slug is transparent to it) |

## Out of Scope

- Automatic merge/rebase of worktree branches (git operations beyond `worktree remove`)
- Worktree creation from within Project Minder
- Background polling of worktree status (can be added later as Option C optimization)
- Support for non-Claude-Code worktrees (`.worktrees/` internal dev worktrees)
