# Worktree Overlay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface TODO.md, MANUAL_STEPS.md, and INSIGHTS.md from active git worktrees alongside their parent project in the Project Minder dashboard — read-only, no writes to worktree files.

**Architecture:** When scanning `C:\dev\*`, detect worktree directories by the `--claude-worktrees-` naming convention. Read markdown files from each worktree and attach them to the parent project's data as `WorktreeOverlay[]`. The UI renders worktree items in collapsible grouped sections below main-branch items, clearly labeled with the branch name. All worktree data is read-only.

**Tech Stack:** Next.js 16 (App Router), TypeScript, React 19, Tailwind CSS v4, Lucide icons, hand-rolled shadcn-style components.

**Validation:** This project has no test framework (no jest/vitest). Validation is done via `npm run build` (type-check) and manual verification in the browser at `http://localhost:4100`.

---

## File Structure

### New Files

| File | Responsibility |
|---|---|
| `src/lib/scanner/worktrees.ts` | Discover worktree directories, read their markdown files, attach overlays to parent projects |
| `src/components/WorktreeSection.tsx` | Shared collapsible UI wrapper for worktree items — branch pill, item count, expand/collapse, read-only label |

### Modified Files

| File | Change |
|---|---|
| `src/lib/types.ts` | Add `WorktreeOverlay` interface, add `worktrees?` field to `ProjectData` |
| `src/lib/scanner/index.ts` | Call `attachWorktreeOverlays()` after main scan, pass directory names list |
| `src/lib/manualStepsWatcher.ts` | Extend `scanForFiles()` to discover worktree `MANUAL_STEPS.md` files |
| `src/components/TodoList.tsx` | Accept `worktrees` prop, render worktree TODO sections below main list |
| `src/components/ManualStepsList.tsx` | Accept `worktrees` prop, render worktree steps sections below main list |
| `src/components/InsightsTab.tsx` | Accept `worktrees` prop, render worktree insights sections below main list |
| `src/components/WorktreeSection.tsx` | (Created in Task 4) |
| `src/components/ProjectDetail.tsx` | Pass `project.worktrees` to TodoList, ManualStepsList, InsightsTab |
| `src/components/ProjectCard.tsx` | Aggregate worktree counts into compact badges |

---

### Task 1: Add WorktreeOverlay Type and ProjectData Field

**Files:**
- Modify: `src/lib/types.ts`

- [ ] **Step 1: Add WorktreeOverlay interface and worktrees field**

In `src/lib/types.ts`, add the `WorktreeOverlay` interface after the `InsightsInfo` interface (after line 122), and add the `worktrees?` field to `ProjectData`.

Add after line 122 (after the closing `}` of `InsightsInfo`):

```typescript
export interface WorktreeOverlay {
  branch: string;           // e.g. "feature/gitwc"
  worktreePath: string;     // full path to worktree directory
  todos?: TodoInfo;
  manualSteps?: ManualStepsInfo;
  insights?: InsightsInfo;
}
```

In the `ProjectData` interface, add after the `insights?: InsightsInfo;` line (line 39):

```typescript
  // Worktree overlays
  worktrees?: WorktreeOverlay[];
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No new errors (existing errors from unused imports are fine — look for errors in `types.ts` specifically).

- [ ] **Step 3: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat(worktree): add WorktreeOverlay type and worktrees field to ProjectData"
```

---

### Task 2: Create Worktree Scanner Module

**Files:**
- Create: `src/lib/scanner/worktrees.ts`

- [ ] **Step 1: Create the worktree scanner module**

Create `src/lib/scanner/worktrees.ts` with the following content:

```typescript
import { promises as fs } from "fs";
import path from "path";
import { ProjectData, WorktreeOverlay } from "../types";
import { scanTodoMd } from "./todoMd";
import { scanManualStepsMd } from "./manualStepsMd";
import { scanInsightsMd } from "./insightsMd";

const WORKTREE_SEP = "--claude-worktrees-";

/**
 * Parse the branch name from a worktree's `.git` file.
 *
 * Worktree `.git` files contain a single line like:
 *   gitdir: C:/dev/project-minder/.git/worktrees/feature-gitwc
 *
 * From that gitdir path, we read the `HEAD` file to get the actual branch ref.
 * Falls back to deriving a branch hint from the directory name.
 */
async function readWorktreeBranch(
  worktreePath: string,
  branchHint: string
): Promise<string> {
  try {
    const gitFileContent = await fs.readFile(
      path.join(worktreePath, ".git"),
      "utf-8"
    );
    const gitdirMatch = gitFileContent.trim().match(/^gitdir:\s*(.+)$/m);
    if (!gitdirMatch) return fallbackBranch(branchHint);

    const gitdir = gitdirMatch[1].trim();
    const headContent = await fs.readFile(
      path.join(gitdir, "HEAD"),
      "utf-8"
    );
    const refMatch = headContent.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
    if (refMatch) return refMatch[1];

    // Detached HEAD — use hint
    return fallbackBranch(branchHint);
  } catch {
    return fallbackBranch(branchHint);
  }
}

/**
 * Convert a directory-name branch hint to a plausible branch name.
 * Claude Code encodes `/` as `-` in directory names, but branch names
 * commonly use a single namespace prefix (feature/, fix/, etc.).
 * Replace only the first `-` with `/` if the hint contains one.
 */
function fallbackBranch(hint: string): string {
  return hint.replace("-", "/");
}

/**
 * Discover worktree directories in devRoot and attach their markdown
 * file data to the corresponding parent projects.
 *
 * Mutates the `projects` array in-place, adding `worktrees` arrays.
 */
export async function attachWorktreeOverlays(
  projects: ProjectData[],
  allDirNames: string[],
  devRoot: string
): Promise<void> {
  // Build a lookup: lowercase dir name → project
  const dirNameToProject = new Map<string, ProjectData>();
  for (const p of projects) {
    const dirName = path.basename(p.path);
    dirNameToProject.set(dirName.toLowerCase(), p);
  }

  // Find worktree directories
  const worktreeDirs = allDirNames.filter((d) =>
    d.toLowerCase().includes(WORKTREE_SEP.toLowerCase())
  );

  if (worktreeDirs.length === 0) return;

  // Process worktree directories in parallel
  const tasks = worktreeDirs.map(async (dirName) => {
    const sepIndex = dirName.toLowerCase().indexOf(WORKTREE_SEP.toLowerCase());
    const prefix = dirName.slice(0, sepIndex);
    const branchHint = dirName.slice(sepIndex + WORKTREE_SEP.length);

    // Find parent project
    const parent = dirNameToProject.get(prefix.toLowerCase());
    if (!parent) return;

    const worktreePath = path.join(devRoot, dirName);

    // Read actual branch name and markdown files in parallel
    const [branch, todos, manualSteps, insights] = await Promise.all([
      readWorktreeBranch(worktreePath, branchHint),
      scanTodoMd(worktreePath),
      scanManualStepsMd(worktreePath),
      scanInsightsMd(worktreePath),
    ]);

    // Only attach if at least one file has data
    if (!todos && !manualSteps && !insights) return;

    const overlay: WorktreeOverlay = {
      branch,
      worktreePath,
      todos,
      manualSteps,
      insights,
    };

    if (!parent.worktrees) parent.worktrees = [];
    parent.worktrees.push(overlay);
  });

  await Promise.all(tasks);
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors in `src/lib/scanner/worktrees.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/lib/scanner/worktrees.ts
git commit -m "feat(worktree): add worktree scanner module for discovering overlays"
```

---

### Task 3: Integrate Worktree Scanner into Main Scanner

**Files:**
- Modify: `src/lib/scanner/index.ts`

- [ ] **Step 1: Import attachWorktreeOverlays**

Add this import at the top of `src/lib/scanner/index.ts`, after line 13 (the `scanInsightsMd` import):

```typescript
import { attachWorktreeOverlays } from "./worktrees";
```

- [ ] **Step 2: Pass directory names and call attachWorktreeOverlays**

In the `scanAllProjects()` function, the `entries` variable (line 131) holds directory names. After the main scan loop and before applying saved statuses (line 153), add the worktree overlay call.

Replace this section (lines 153-161):

```typescript
  // Apply saved statuses and port overrides
  for (const project of projects) {
    if (config.statuses[project.slug]) {
      project.status = config.statuses[project.slug];
    }
    if (config.portOverrides[project.slug] !== undefined) {
      project.devPort = config.portOverrides[project.slug];
    }
  }
```

With:

```typescript
  // Attach worktree overlays (reads TODO.md, MANUAL_STEPS.md, INSIGHTS.md from worktree dirs)
  await attachWorktreeOverlays(projects, entries, devRoot);

  // Apply saved statuses and port overrides
  for (const project of projects) {
    if (config.statuses[project.slug]) {
      project.status = config.statuses[project.slug];
    }
    if (config.portOverrides[project.slug] !== undefined) {
      project.devPort = config.portOverrides[project.slug];
    }
  }
```

**Important:** The `entries` variable was filtered to remove hidden projects on line 139. But worktree directories themselves shouldn't be in the hidden list (they're `project--claude-worktrees-branch` names). However, the hidden filter may have removed them if they happened to be listed. To be safe, we need to use the original unfiltered directory list for worktree discovery.

Refactor: Rename the initial `entries` to keep an unfiltered copy. Replace lines 130-139:

```typescript
  let entries: string[];
  try {
    const dirents = await fs.readdir(devRoot, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return { projects: [], portConflicts: [], hiddenCount: 0, scannedAt: new Date().toISOString() };
  }

  // Keep full list for worktree discovery before filtering
  const allDirNames = [...entries];

  // Filter out hidden projects
  const hiddenSet = new Set(config.hidden.map((h) => h.toLowerCase()));
  entries = entries.filter((e) => !hiddenSet.has(e.toLowerCase()));
```

Then update the `attachWorktreeOverlays` call to use `allDirNames`:

```typescript
  await attachWorktreeOverlays(projects, allDirNames, devRoot);
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/scanner/index.ts
git commit -m "feat(worktree): integrate worktree scanner into main scan loop"
```

---

### Task 4: Create WorktreeSection UI Component

**Files:**
- Create: `src/components/WorktreeSection.tsx`

- [ ] **Step 1: Create the WorktreeSection component**

Create `src/components/WorktreeSection.tsx`:

```typescript
"use client";

import { useState } from "react";
import { Badge } from "./ui/badge";
import { ChevronDown, ChevronRight, GitBranch } from "lucide-react";

interface WorktreeSectionProps {
  branch: string;
  itemCount: number;
  itemLabel: string; // e.g. "TODOs", "steps", "insights"
  children: React.ReactNode;
}

export function WorktreeSection({
  branch,
  itemCount,
  itemLabel,
  children,
}: WorktreeSectionProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border-l-2 border-blue-500/30 pl-3 mt-4">
      <button
        className="flex items-center gap-2 w-full text-left py-2 hover:bg-[var(--muted)] rounded px-2 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-[var(--muted-foreground)]" />
        )}
        <GitBranch className="h-3.5 w-3.5 text-blue-400 shrink-0" />
        <Badge variant="secondary" className="text-xs font-mono px-2 py-0">
          {branch}
        </Badge>
        <span className="text-xs text-[var(--muted-foreground)]">
          {itemCount} {itemLabel}
        </span>
      </button>

      {expanded && (
        <div className="mt-2 space-y-1">
          <p className="text-xs text-[var(--muted-foreground)] italic px-2">
            Read-only — from active worktree
          </p>
          {children}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/WorktreeSection.tsx
git commit -m "feat(worktree): add WorktreeSection collapsible UI wrapper"
```

---

### Task 5: Add Worktree Overlays to TodoList

**Files:**
- Modify: `src/components/TodoList.tsx`
- Modify: `src/components/ProjectDetail.tsx`

- [ ] **Step 1: Add worktree sections to TodoList**

In `src/components/TodoList.tsx`, add the import and worktree rendering.

Add import at the top (after the existing imports):

```typescript
import { WorktreeOverlay } from "@/lib/types";
import { WorktreeSection } from "./WorktreeSection";
```

Update the `TodoListProps` interface to accept worktrees:

```typescript
interface TodoListProps {
  todos: TodoInfo;
  slug?: string;
  onChange?: (updated: TodoInfo) => void;
  worktrees?: WorktreeOverlay[];
}
```

Update the function signature:

```typescript
export function TodoList({ todos, slug, onChange, worktrees }: TodoListProps) {
```

Add worktree sections after the closing `</ul>` tag (after line 78) and before the `{slug && <AddTodoForm .../>}` line:

```typescript
      {worktrees?.map((wt) =>
        wt.todos ? (
          <WorktreeSection
            key={wt.worktreePath}
            branch={wt.branch}
            itemCount={wt.todos.total}
            itemLabel={wt.todos.total === 1 ? "TODO" : "TODOs"}
          >
            <ul className="space-y-1">
              {wt.todos.items
                .filter((item) => {
                  if (filter === "open") return !item.completed;
                  if (filter === "done") return item.completed;
                  return true;
                })
                .map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    {item.completed ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                    ) : (
                      <Circle className="h-4 w-4 text-[var(--muted-foreground)] mt-0.5 shrink-0" />
                    )}
                    <span className={item.completed ? "line-through text-[var(--muted-foreground)]" : ""}>
                      {item.text}
                    </span>
                  </li>
                ))}
            </ul>
          </WorktreeSection>
        ) : null
      )}
```

- [ ] **Step 2: Pass worktrees from ProjectDetail to TodoList**

In `src/components/ProjectDetail.tsx`, update the TodoList usage (around line 241).

Replace:

```typescript
              <TodoList todos={todos} slug={project.slug} onChange={setTodos} />
```

With:

```typescript
              <TodoList todos={todos} slug={project.slug} onChange={setTodos} worktrees={project.worktrees} />
```

Also add the worktree overlays for when there are no main TODOs but there ARE worktree TODOs. Replace the entire `<TabsContent value="todos">` block (lines 238-251):

```typescript
        <TabsContent value="todos">
          <div className="rounded-lg border p-6">
            {todos ? (
              <TodoList todos={todos} slug={project.slug} onChange={setTodos} worktrees={project.worktrees} />
            ) : project.worktrees?.some((wt) => wt.todos) ? (
              <div className="space-y-4">
                <p className="text-[var(--muted-foreground)] text-sm">
                  No TODO items on main branch.
                </p>
                <AddTodoForm slug={project.slug} onAdded={setTodos} />
                {project.worktrees.map((wt) =>
                  wt.todos ? (
                    <WorktreeSection
                      key={wt.worktreePath}
                      branch={wt.branch}
                      itemCount={wt.todos.total}
                      itemLabel={wt.todos.total === 1 ? "TODO" : "TODOs"}
                    >
                      <ul className="space-y-1">
                        {wt.todos.items.map((item, i) => (
                          <li key={i} className="flex items-start gap-2 text-sm">
                            {item.completed ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                            ) : (
                              <Circle className="h-4 w-4 text-[var(--muted-foreground)] mt-0.5 shrink-0" />
                            )}
                            <span className={item.completed ? "line-through text-[var(--muted-foreground)]" : ""}>
                              {item.text}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </WorktreeSection>
                  ) : null
                )}
              </div>
            ) : (
              <div className="space-y-4">
                <p className="text-[var(--muted-foreground)] text-sm">
                  No TODO items found for this project. Add an item below to create or seed <code>TODO.md</code>.
                </p>
                <AddTodoForm slug={project.slug} onAdded={setTodos} />
              </div>
            )}
          </div>
        </TabsContent>
```

Add imports at the top of `ProjectDetail.tsx` (add to the existing lucide import):

```typescript
import { CheckCircle2, Circle } from "lucide-react";
```

And add the WorktreeSection import:

```typescript
import { WorktreeSection } from "./WorktreeSection";
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/TodoList.tsx src/components/ProjectDetail.tsx
git commit -m "feat(worktree): show worktree TODOs in grouped sections on project detail"
```

---

### Task 6: Add Worktree Overlays to ManualStepsList

**Files:**
- Modify: `src/components/ManualStepsList.tsx`
- Modify: `src/components/ProjectDetail.tsx`

- [ ] **Step 1: Add worktree sections to ManualStepsList**

In `src/components/ManualStepsList.tsx`, add imports at the top:

```typescript
import { WorktreeOverlay } from "@/lib/types";
import { WorktreeSection } from "./WorktreeSection";
```

Update the `ManualStepsList` component props. Replace:

```typescript
export function ManualStepsList({
  slug,
  initialData,
}: {
  slug: string;
  initialData: ManualStepsInfo;
}) {
```

With:

```typescript
export function ManualStepsList({
  slug,
  initialData,
  worktrees,
}: {
  slug: string;
  initialData: ManualStepsInfo;
  worktrees?: WorktreeOverlay[];
}) {
```

After the closing `</div>` of the `filteredEntries` map section (after line 245, before the final `</div>` and `</div>`), add worktree sections:

```typescript
      {worktrees?.map((wt) =>
        wt.manualSteps && wt.manualSteps.totalSteps > 0 ? (
          <WorktreeSection
            key={wt.worktreePath}
            branch={wt.branch}
            itemCount={wt.manualSteps.totalSteps}
            itemLabel={wt.manualSteps.totalSteps === 1 ? "step" : "steps"}
          >
            <div className="space-y-2">
              {wt.manualSteps.entries
                .filter((entry) =>
                  filter === "all"
                    ? true
                    : entry.steps.some((s) =>
                        filter === "open" ? !s.completed : s.completed
                      )
                )
                .map((entry, i) => (
                  <div key={i} className="rounded-lg border overflow-hidden">
                    <div className="p-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-[var(--muted-foreground)] font-mono">
                          {entry.date}
                        </span>
                        <span className="text-xs bg-[var(--muted)] px-1.5 py-0.5 rounded font-mono">
                          {entry.featureSlug}
                        </span>
                      </div>
                      <p className="text-sm font-medium truncate">{entry.title}</p>
                    </div>
                    <div className="border-t px-3 py-2 space-y-1">
                      {entry.steps
                        .filter((step) => {
                          if (filter === "open") return !step.completed;
                          if (filter === "done") return step.completed;
                          return true;
                        })
                        .map((step, j) => (
                          <div key={j} className="flex items-start gap-2 text-sm px-1 py-0.5">
                            {step.completed ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-500 mt-0.5 shrink-0" />
                            ) : (
                              <Circle className="h-4 w-4 text-[var(--muted-foreground)] mt-0.5 shrink-0" />
                            )}
                            <span
                              className={
                                step.completed
                                  ? "line-through text-[var(--muted-foreground)]"
                                  : ""
                              }
                            >
                              {step.text}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                ))}
            </div>
          </WorktreeSection>
        ) : null
      )}
```

- [ ] **Step 2: Pass worktrees from ProjectDetail to ManualStepsList**

In `src/components/ProjectDetail.tsx`, update the ManualStepsList usage (around line 272).

Replace:

```typescript
              <ManualStepsList
                slug={project.slug}
                initialData={project.manualSteps}
              />
```

With:

```typescript
              <ManualStepsList
                slug={project.slug}
                initialData={project.manualSteps}
                worktrees={project.worktrees}
              />
```

Also handle the case where main has no manual steps but worktrees do. Replace the entire `<TabsContent value="manual-steps">` block:

```typescript
        <TabsContent value="manual-steps">
          {project.manualSteps ? (
            <div className="rounded-lg border p-6">
              <ManualStepsList
                slug={project.slug}
                initialData={project.manualSteps}
                worktrees={project.worktrees}
              />
            </div>
          ) : project.worktrees?.some((wt) => wt.manualSteps) ? (
            <div className="rounded-lg border p-6">
              <p className="text-[var(--muted-foreground)] text-sm mb-4">
                No MANUAL_STEPS.md on main branch.
              </p>
              {project.worktrees.map((wt) =>
                wt.manualSteps && wt.manualSteps.totalSteps > 0 ? (
                  <WorktreeSection
                    key={wt.worktreePath}
                    branch={wt.branch}
                    itemCount={wt.manualSteps.totalSteps}
                    itemLabel={wt.manualSteps.totalSteps === 1 ? "step" : "steps"}
                  >
                    <p className="text-xs text-[var(--muted-foreground)]">
                      {wt.manualSteps.pendingSteps} pending
                    </p>
                  </WorktreeSection>
                ) : null
              )}
            </div>
          ) : (
            <p className="text-[var(--muted-foreground)] py-8 text-center">
              No MANUAL_STEPS.md found for this project.
            </p>
          )}
        </TabsContent>
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/ManualStepsList.tsx src/components/ProjectDetail.tsx
git commit -m "feat(worktree): show worktree manual steps in grouped sections on project detail"
```

---

### Task 7: Add Worktree Overlays to InsightsTab

**Files:**
- Modify: `src/components/InsightsTab.tsx`
- Modify: `src/components/ProjectDetail.tsx`

- [ ] **Step 1: Add worktree sections to InsightsTab**

In `src/components/InsightsTab.tsx`, add imports:

```typescript
import { WorktreeOverlay } from "@/lib/types";
import { WorktreeSection } from "./WorktreeSection";
```

Update the props interface and component:

```typescript
interface InsightsTabProps {
  slug: string;
  worktrees?: WorktreeOverlay[];
}

export function InsightsTab({ slug, worktrees }: InsightsTabProps) {
```

After the total count paragraph (after line 93, before the closing `</div>`), add worktree sections:

```typescript
      {worktrees?.map((wt) =>
        wt.insights && wt.insights.total > 0 ? (
          <WorktreeSection
            key={wt.worktreePath}
            branch={wt.branch}
            itemCount={wt.insights.total}
            itemLabel={wt.insights.total === 1 ? "insight" : "insights"}
          >
            <ul className="space-y-3">
              {wt.insights.entries
                .filter((e) =>
                  e.content.toLowerCase().includes(query.toLowerCase())
                )
                .map((insight) => (
                  <li
                    key={insight.id}
                    className="rounded-lg border p-4 space-y-2"
                  >
                    <div className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]">
                      <span className="flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {(() => {
                          const d = new Date(insight.date);
                          return isFinite(d.getTime())
                            ? d.toLocaleDateString(undefined, {
                                year: "numeric",
                                month: "short",
                                day: "numeric",
                              })
                            : "—";
                        })()}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed">{insight.content}</p>
                  </li>
                ))}
            </ul>
          </WorktreeSection>
        ) : null
      )}
```

- [ ] **Step 2: Pass worktrees from ProjectDetail to InsightsTab**

In `src/components/ProjectDetail.tsx`, update the InsightsTab usage (around line 286).

Replace:

```typescript
            <InsightsTab slug={project.slug} />
```

With:

```typescript
            <InsightsTab slug={project.slug} worktrees={project.worktrees} />
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/InsightsTab.tsx src/components/ProjectDetail.tsx
git commit -m "feat(worktree): show worktree insights in grouped sections on project detail"
```

---

### Task 8: Aggregate Worktree Counts in Dashboard Badges

**Files:**
- Modify: `src/components/ProjectCard.tsx`

- [ ] **Step 1: Aggregate worktree data into compact badges**

In `src/components/ProjectCard.tsx`, the compact badges currently render from `project.todos`, `project.manualSteps`, and `project.insights` directly. We need to compute aggregated totals that include worktree data.

Add a helper block inside the `ProjectCard` component, after the `dirName` line (line 37):

```typescript
  // Aggregate worktree counts into badge data
  const aggregatedTodos = (() => {
    if (!project.todos && !project.worktrees?.some((wt) => wt.todos)) return undefined;
    const mainTodos = project.todos ?? { total: 0, completed: 0, pending: 0, items: [] };
    const wtTotals = (project.worktrees ?? []).reduce(
      (acc, wt) => {
        if (!wt.todos) return acc;
        return {
          total: acc.total + wt.todos.total,
          completed: acc.completed + wt.todos.completed,
          pending: acc.pending + wt.todos.pending,
        };
      },
      { total: 0, completed: 0, pending: 0 }
    );
    return {
      total: mainTodos.total + wtTotals.total,
      completed: mainTodos.completed + wtTotals.completed,
      pending: mainTodos.pending + wtTotals.pending,
      items: mainTodos.items,
    };
  })();

  const aggregatedManualSteps = (() => {
    if (!project.manualSteps && !project.worktrees?.some((wt) => wt.manualSteps)) return undefined;
    const main = project.manualSteps ?? { entries: [], totalSteps: 0, completedSteps: 0, pendingSteps: 0 };
    const wtTotals = (project.worktrees ?? []).reduce(
      (acc, wt) => {
        if (!wt.manualSteps) return acc;
        return {
          totalSteps: acc.totalSteps + wt.manualSteps.totalSteps,
          completedSteps: acc.completedSteps + wt.manualSteps.completedSteps,
          pendingSteps: acc.pendingSteps + wt.manualSteps.pendingSteps,
        };
      },
      { totalSteps: 0, completedSteps: 0, pendingSteps: 0 }
    );
    return {
      entries: main.entries,
      totalSteps: main.totalSteps + wtTotals.totalSteps,
      completedSteps: main.completedSteps + wtTotals.completedSteps,
      pendingSteps: main.pendingSteps + wtTotals.pendingSteps,
    };
  })();

  const aggregatedInsights = (() => {
    if (!project.insights && !project.worktrees?.some((wt) => wt.insights)) return undefined;
    const main = project.insights ?? { entries: [], total: 0 };
    const wtTotal = (project.worktrees ?? []).reduce(
      (acc, wt) => acc + (wt.insights?.total ?? 0),
      0
    );
    return {
      entries: main.entries,
      total: main.total + wtTotal,
    };
  })();
```

Then update the three badge lines. Replace:

```typescript
        {project.todos && <TodoCompact todos={project.todos} />}
        {project.manualSteps && <ManualStepsCompact manualSteps={project.manualSteps} />}
        {project.insights && <InsightsCompact insights={project.insights} />}
```

With:

```typescript
        {aggregatedTodos && <TodoCompact todos={aggregatedTodos} />}
        {aggregatedManualSteps && <ManualStepsCompact manualSteps={aggregatedManualSteps} />}
        {aggregatedInsights && <InsightsCompact insights={aggregatedInsights} />}
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/ProjectCard.tsx
git commit -m "feat(worktree): aggregate worktree counts in dashboard card badges"
```

---

### Task 9: Extend ManualStepsWatcher for Worktree Files

**Files:**
- Modify: `src/lib/manualStepsWatcher.ts`

- [ ] **Step 1: Add worktree discovery to scanForFiles**

In `src/lib/manualStepsWatcher.ts`, the `scanForFiles()` method (line 42) scans `devRoot` directories. After the main loop over directories, add a second loop for worktree directories.

Add this constant at the top of the file, after the existing constants (after line 10):

```typescript
const WORKTREE_SEP = "--claude-worktrees-";
```

In the `scanForFiles()` method, after the main `for (const dirName of dirs)` loop (after line 61), add:

```typescript
      // Discover MANUAL_STEPS.md in worktree directories
      for (const dirName of dirs) {
        if (!dirName.includes(WORKTREE_SEP)) continue;

        const sepIndex = dirName.indexOf(WORKTREE_SEP);
        const prefix = dirName.slice(0, sepIndex);
        const branchHint = dirName.slice(sepIndex + WORKTREE_SEP.length);

        // Build composite slug to avoid collision with main project
        const parentSlug = prefix.toLowerCase().replace(/[^a-z0-9-]/g, "-");
        const compositeSlug = `${parentSlug}:worktree:${branchHint}`;

        if (this.watched.has(compositeSlug)) continue;

        const filePath = path.join(devRoot, dirName, "MANUAL_STEPS.md");
        try {
          await fs.access(filePath);
          await this.watchFile(compositeSlug, `${prefix} (${branchHint})`, filePath);
          invalidateCache();
        } catch {
          // No MANUAL_STEPS.md in this worktree
        }
      }
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/manualStepsWatcher.ts
git commit -m "feat(worktree): extend ManualStepsWatcher to discover worktree MANUAL_STEPS.md files"
```

---

### Task 10: Build Verification and Documentation

**Files:**
- Modify: `CLAUDE.md` (update architecture section)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Run full production build**

Run: `npm run build`
Expected: Build succeeds with no type errors.

- [ ] **Step 2: Update CLAUDE.md architecture section**

In `CLAUDE.md`, add a subsection under the Architecture heading, after the "Manual Steps Watcher" subsection:

```markdown
### Worktree Overlay (`src/lib/scanner/worktrees.ts`)
- Discovers Claude Code worktree directories in devRoot by `--claude-worktrees-` naming convention
- Reads TODO.md, MANUAL_STEPS.md, INSIGHTS.md from each worktree directory
- Attaches `WorktreeOverlay[]` to parent project's `ProjectData` — purely read-only
- Branch name resolved from worktree `.git` file's `gitdir:` → `HEAD` ref, with directory-name fallback
- ManualStepsWatcher extended to also watch worktree MANUAL_STEPS.md files (composite slug `parentslug:worktree:branchhint`)
```

- [ ] **Step 3: Update CHANGELOG.md**

Add under `[Unreleased]`:

```markdown
### Added
- Worktree overlay: TODOs, Manual Steps, and Insights from active Claude Code worktrees now appear in grouped collapsible sections on project detail pages
- Dashboard card badges aggregate main + worktree item counts
- ManualStepsWatcher discovers and watches worktree MANUAL_STEPS.md files for change notifications
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md CHANGELOG.md
git commit -m "docs: add worktree overlay to architecture docs and changelog"
```

---

## Self-Review

**Spec coverage check:**

| Spec Requirement | Task |
|---|---|
| WorktreeOverlay type + ProjectData field | Task 1 |
| Worktree discovery via filesystem convention | Task 2 |
| Scanner integration (post-scan attachment) | Task 3 |
| Collapsible WorktreeSection UI wrapper | Task 4 |
| TodoList worktree sections | Task 5 |
| ManualStepsList worktree sections | Task 6 |
| InsightsTab worktree sections | Task 7 |
| Dashboard badge aggregation | Task 8 |
| ManualStepsWatcher extension | Task 9 |
| Read-only (no write endpoints) | All tasks — no write endpoints added |
| Branch name from .git file with fallback | Task 2 (readWorktreeBranch + fallbackBranch) |
| Always-on, no config | Tasks 2-3 — no config gating |
| Documentation | Task 10 |

**Placeholder scan:** No TBD, TODO, or "implement later" found. All steps have complete code.

**Type consistency:** `WorktreeOverlay` used consistently across all tasks. `worktrees?: WorktreeOverlay[]` on ProjectData matches all prop types. `attachWorktreeOverlays` signature matches call site. Composite slug format `parentslug:worktree:branchhint` consistent between spec and Task 9.
