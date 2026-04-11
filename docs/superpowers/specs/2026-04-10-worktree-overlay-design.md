# Worktree Overlay — Design Spec

## Goal

Surface TODO.md, MANUAL_STEPS.md, and INSIGHTS.md from active git worktrees alongside their parent project's data in Project Minder. Read-only — no writes to worktree files.

## Decisions

| Decision | Choice |
|---|---|
| Approach | Worktree Overlay — read from worktrees, merge into parent project UI |
| UI grouping | Grouped sections — main items first, then collapsible worktree section per branch |
| Discovery method | Filesystem naming convention (`*--claude-worktrees-*`) |
| Opt-in/out | Always-on, no config needed |

## Architecture

### Worktree Discovery

Claude Code creates worktrees as sibling directories in `C:\dev\` following the naming convention:

```
{project-dir-name}--claude-worktrees-{branch-hint}
```

For example: `project-minder--claude-worktrees-feature-gitwc`

These directories have a `.git` **file** (not directory) that points to the parent repo's `.git/worktrees/` directory. The existing `isGitRepo()` check requires a `.git` directory, so worktrees are correctly skipped as standalone projects — no duplicate project entries.

Discovery is filesystem-only — no `git worktree list` subprocess calls. The scanner reads `C:\dev\*` directory entries (which it already does), filters for the `--claude-worktrees-` pattern, and matches prefixes to known projects.

### New Type

```typescript
interface WorktreeOverlay {
  branch: string;           // e.g. "feature/gitwc"
  worktreePath: string;     // full path to worktree directory
  todos?: TodoInfo;
  manualSteps?: ManualStepsInfo;
  insights?: InsightsInfo;
}
```

Added to `ProjectData`:

```typescript
worktrees?: WorktreeOverlay[];
```

### Scanner Integration

New module: `src/lib/scanner/worktrees.ts`

Exports one function:

```typescript
export async function attachWorktreeOverlays(
  projects: ProjectData[],
  allDirNames: string[],
  devRoot: string
): Promise<void>
```

Called by `scanAllProjects()` **after** the main scan loop completes. Mutates projects in-place, adding `worktrees` arrays where worktree directories are found.

**Matching logic:**

1. Filter `allDirNames` for entries containing `--claude-worktrees-`
2. For each match, split on `--claude-worktrees-` to get `prefix` and `branchHint`
3. Find the parent project by matching `prefix` (case-insensitive) against project directory names
4. Read the actual branch name from the worktree's `.git` file → parse `gitdir:` path → read `HEAD` from that worktree git directory. Fallback: if `.git` file can't be parsed, use the branch hint from the directory name (the part after `--claude-worktrees-`), replacing the first hyphen with `/` if it looks like a namespaced branch (e.g., `feature-gitwc` → `feature/gitwc`)
5. Read `TODO.md`, `MANUAL_STEPS.md`, `INSIGHTS.md` from the worktree path using existing scanner functions (`scanTodoMd`, `scanManualStepsMd`, `scanInsightsMd`)
6. Attach results as a `WorktreeOverlay` on the matched parent project

### ManualStepsWatcher Extension

`manualStepsWatcher.ts`'s `scanForFiles()` method gains worktree awareness:

- After scanning real project directories, filter directory listing for `--claude-worktrees-` entries
- Watch worktree `MANUAL_STEPS.md` files using the existing `watchFile()` mechanism
- Use composite slug `{projectslug}:worktree:{branchname}` internally to avoid key collisions
- Change events include branch name for notification display: "New manual step in project-minder (feature/gitwc)"

No watcher for `TODO.md` — follows existing pattern where TODOs are scan-time only.

## UI

### Grouped Worktree Sections

Each tab that shows TODO/ManualSteps/Insights items gains a collapsible worktree section below the main content.

**New shared component:** `WorktreeSection` — generic collapsible wrapper accepting branch name, item count, and children.

**Pattern (same for TodoList, ManualStepsList, InsightsTab):**

1. Main-branch items render as today — no changes
2. Below the main list, for each `WorktreeOverlay` with relevant data, render a collapsible section:
   - Header: git branch icon + branch name pill + item count
   - Collapsed by default
   - Expand to show items in the same visual style as main-branch items
3. Worktree items are **read-only** — no checkbox toggling, no "Add TODO" form

**Visual treatment:**

- Subtle left border to distinguish from main content
- Branch name as small colored pill (existing badge component)
- Muted "Read-only — from active worktree" note

**Props changes:**

- `TodoList` — accepts optional `worktrees?: WorktreeOverlay[]`
- `ManualStepsList` — accepts optional `worktrees?: WorktreeOverlay[]`
- `InsightsTab` — accepts optional `worktrees?: WorktreeOverlay[]`
- `ProjectDetail` passes `project.worktrees` down to each tab

### Dashboard Badges

Compact badges on `ProjectCard` (`TodoCompact`, `ManualStepsCompact`, `InsightsCompact`) aggregate main + worktree item counts. No separate worktree badge — the combined total is what matters at the card level. Worktree vs. main breakdown is visible on the detail page.

### API

No new API routes. The `worktrees` field on `ProjectData` flows through existing endpoints:

- `GET /api/projects` — all projects, now includes `worktrees`
- `GET /api/projects/[slug]` — single project, includes `worktrees`
- `GET /api/manual-steps/changes` — watcher now emits events for worktree files using composite slug format

No write endpoints for worktree items. `POST /api/todos/[slug]` and `POST /api/manual-steps/[slug]` operate on main project paths only.

## Files

### Create

- `src/lib/scanner/worktrees.ts` — worktree discovery and overlay attachment
- `src/components/WorktreeSection.tsx` — shared collapsible worktree wrapper

### Modify

- `src/lib/types.ts` — add `WorktreeOverlay` interface, add `worktrees?` to `ProjectData`
- `src/lib/scanner/index.ts` — call `attachWorktreeOverlays()` after main scan, pass `allDirNames`
- `src/lib/manualStepsWatcher.ts` — extend `scanForFiles()` to discover worktree MANUAL_STEPS.md
- `src/components/TodoList.tsx` — accept `worktrees` prop, render grouped worktree section
- `src/components/ManualStepsList.tsx` — accept `worktrees` prop, render grouped worktree section
- `src/components/InsightsTab.tsx` — accept `worktrees` prop, render grouped worktree section
- `src/components/ProjectDetail.tsx` — pass `project.worktrees` to tab components
- `src/components/ProjectCard.tsx` — aggregate worktree counts into compact badges

## Non-Goals

- Writing to worktree files (corruption risk, merge conflicts)
- Discovering worktrees via `git worktree list` subprocess
- Config toggle for enabling/disabling worktree overlay
- Separate worktree badges on dashboard cards
- Worktree support for non-Claude-Code-created worktrees
