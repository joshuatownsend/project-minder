# Worktree Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add worktree-aware dev server control, markdown sync, and stale-worktree cleanup to Project Minder's project detail page.

**Architecture:** A new `/api/worktrees/[slug]` route runs on-demand git checks per worktree (merged status, remote branch existence, dirty status) and handles start-server and remove actions. A new `WorktreePanel` component on the project detail Overview tab renders these controls lazily on first expand. Pure logic (port finding, sync diffing, git status parsing) is unit-tested; UI and routes are validated via `npm run build` and manual browser testing.

**Tech Stack:** Next.js App Router API routes, TypeScript, child_process.execFile, existing `processManager` singleton, vitest for unit tests.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/lib/types.ts` | Modify | Add `WorktreeStatus` interface |
| `src/lib/processManager.ts` | Modify | Export `findFreePort(startPort, maxAttempts?, checker?)` |
| `src/lib/worktreeChecker.ts` | Create | `checkWorktreeStatus()` — runs 4 git commands per worktree |
| `src/lib/worktreeSync.ts` | Create | `diffTodos`, `diffManualSteps`, `diffInsights` — pure diff functions |
| `src/app/api/worktrees/[slug]/route.ts` | Create | GET (status list) + POST (start-server, remove) |
| `src/app/api/worktrees/[slug]/sync/route.ts` | Create | POST (append worktree-only entries to parent file) |
| `src/components/WorktreePanel.tsx` | Create | Lazy status panel: dev server, sync badges, stale/remove |
| `src/components/ProjectDetail.tsx` | Modify | Render WorktreePanel in Overview tab when worktrees exist |
| `src/components/ProjectCard.tsx` | Modify | Show `wt N` count badge when project has worktrees |
| `tests/findFreePort.test.ts` | Create | Unit tests for port auto-finding |
| `tests/worktreeChecker.test.ts` | Create | Unit tests for git status parsing |
| `tests/worktreeSync.test.ts` | Create | Unit tests for diff functions |

---

## Task 1: Add WorktreeStatus to types

**Files:** Modify `src/lib/types.ts`

- [ ] **Step 1: Add interface after WorktreeOverlay (~line 127)**

```ts
export interface WorktreeStatus {
  worktreePath: string;
  branch: string;
  isDirty: boolean;
  uncommittedCount: number;
  isMergedLocally: boolean;       // git branch --merged main
  isRemoteBranchDeleted: boolean; // git ls-remote --heads origin <branch> returned empty
  isStale: boolean;               // isMergedLocally && isRemoteBranchDeleted
  lastCommitDate?: string;        // from git log -1 --format=%aI
}
```

- [ ] **Step 2: Verify build** — `npm run build 2>&1 | tail -5` — expect no errors.

- [ ] **Step 3: Commit** — `git add src/lib/types.ts && git commit -m "feat: add WorktreeStatus type"`

---

## Task 2: Add findFreePort to processManager — TDD

**Files:** Modify `src/lib/processManager.ts`, Create `tests/findFreePort.test.ts`

- [ ] **Step 1: Create `tests/findFreePort.test.ts`**

```ts
import { describe, it, expect, vi } from "vitest";
import { findFreePort } from "@/lib/processManager";

describe("findFreePort", () => {
  it("returns startPort when it is free", async () => {
    const checker = vi.fn().mockResolvedValue(false);
    expect(await findFreePort(4101, 10, checker)).toBe(4101);
    expect(checker).toHaveBeenCalledWith(4101);
  });

  it("skips in-use ports and returns next free one", async () => {
    const checker = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    expect(await findFreePort(4101, 10, checker)).toBe(4103);
  });

  it("returns null when all attempts exhausted", async () => {
    const checker = vi.fn().mockResolvedValue(true);
    expect(await findFreePort(4101, 3, checker)).toBeNull();
    expect(checker).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run to verify FAIL** — `npm test -- --reporter=verbose 2>&1 | grep -A3 "findFreePort"`

- [ ] **Step 3: Add to `src/lib/processManager.ts` after the `isPortInUse` function (~line 252)**

```ts
/**
 * Find the next free port starting at startPort.
 * The checker parameter is injectable for testability.
 */
export async function findFreePort(
  startPort: number,
  maxAttempts = 10,
  checker: (port: number) => Promise<boolean> = isPortInUse
): Promise<number | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (!(await checker(port))) return port;
  }
  return null;
}
```

- [ ] **Step 4: Run** — `npm test -- --reporter=verbose 2>&1 | grep -A3 "findFreePort"` — expect 3 passing.

- [ ] **Step 5: Commit** — `git add src/lib/processManager.ts tests/findFreePort.test.ts && git commit -m "feat: add findFreePort"`

---

## Task 3: Create worktreeChecker.ts — TDD

**Files:** Create `src/lib/worktreeChecker.ts`, Create `tests/worktreeChecker.test.ts`

Note: uses `execFile` from node:child_process (NOT exec — no shell injection risk).

- [ ] **Step 1: Create `tests/worktreeChecker.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({ execFile: vi.fn() }));
vi.mock("@/lib/processManager", () => ({ processManager: { get: vi.fn().mockReturnValue(undefined) } }));

import { execFile } from "child_process";
import { checkWorktreeStatus } from "@/lib/worktreeChecker";

const execFileMock = vi.mocked(execFile);

function stubOutputs(outputs: string[]) {
  let call = 0;
  execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
    const cb = callback as (err: null, stdout: string, stderr: string) => void;
    cb(null, (outputs[call++] ?? "") + "\n", "");
    return {} as ReturnType<typeof execFile>;
  });
}

describe("checkWorktreeStatus", () => {
  beforeEach(() => vi.clearAllMocks());

  it("marks stale when merged locally and remote deleted", async () => {
    stubOutputs(["  main\n  feature/foo", "", "", "2026-04-01T10:00:00Z"]);
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/foo", "p:wt:feature-foo");
    expect(s.isMergedLocally).toBe(true);
    expect(s.isRemoteBranchDeleted).toBe(true);
    expect(s.isStale).toBe(true);
    expect(s.isDirty).toBe(false);
  });

  it("not stale when remote branch still exists", async () => {
    stubOutputs(["  main", "abc123\trefs/heads/feature/foo", "", ""]);
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/foo", "p:wt:feature-foo");
    expect(s.isStale).toBe(false);
  });

  it("reports dirty worktree", async () => {
    stubOutputs(["  main", "", " M src/foo.ts\nA  src/bar.ts", ""]);
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/foo", "p:wt:feature-foo");
    expect(s.isDirty).toBe(true);
    expect(s.uncommittedCount).toBe(2);
  });

  it("returns isStale false when git fails (offline safety)", async () => {
    execFileMock.mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (err: Error) => void)(new Error("network unreachable"));
      return {} as ReturnType<typeof execFile>;
    });
    const s = await checkWorktreeStatus("C:/dev/p", "C:/dev/p--wt", "feature/foo", "p:wt:feature-foo");
    expect(s.isStale).toBe(false);
  });
});
```

- [ ] **Step 2: Verify FAIL** — `npm test -- --reporter=verbose 2>&1 | grep -A3 "worktreeChecker"`

- [ ] **Step 3: Create `src/lib/worktreeChecker.ts`**

```ts
import { execFile } from "child_process";
import { WorktreeStatus } from "./types";

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (err, stdout) => {
      resolve(err ? "" : stdout.trim());
    });
  });
}

export async function checkWorktreeStatus(
  parentPath: string,
  worktreePath: string,
  branch: string,
  _worktreeSlug: string
): Promise<WorktreeStatus> {
  const [mergedOutput, remoteOutput, porcelain, lastCommit] = await Promise.all([
    runGit(["branch", "--merged", "main"], parentPath),
    runGit(["ls-remote", "--heads", "origin", branch], parentPath),
    runGit(["status", "--porcelain"], worktreePath),
    runGit(["log", "-1", "--format=%aI"], worktreePath),
  ]);

  const mergedBranches = mergedOutput.split("\n").map((l) => l.trim().replace(/^\*\s*/, "")).filter(Boolean);
  const isMergedLocally = mergedBranches.includes(branch);
  const isRemoteBranchDeleted = remoteOutput.trim() === "";
  const porcelainLines = porcelain ? porcelain.split("\n").filter((l) => l.trim()) : [];

  return {
    worktreePath,
    branch,
    isDirty: porcelainLines.length > 0,
    uncommittedCount: porcelainLines.length,
    isMergedLocally,
    isRemoteBranchDeleted,
    isStale: isMergedLocally && isRemoteBranchDeleted,
    lastCommitDate: lastCommit || undefined,
  };
}
```

- [ ] **Step 4: Run** — `npm test -- --reporter=verbose 2>&1 | grep -A3 "worktreeChecker"` — expect 4 passing.

- [ ] **Step 5: Commit** — `git add src/lib/worktreeChecker.ts tests/worktreeChecker.test.ts && git commit -m "feat: add worktreeChecker"`

---

## Task 4: Create worktreeSync.ts — TDD

**Files:** Create `src/lib/worktreeSync.ts`, Create `tests/worktreeSync.test.ts`

- [ ] **Step 1: Create `tests/worktreeSync.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { diffTodos, diffManualSteps, diffInsights } from "@/lib/worktreeSync";

describe("diffTodos", () => {
  it("returns items in worktree not in parent", () => {
    const parent = [{ text: "fix bug", completed: false }];
    const worktree = [{ text: "fix bug", completed: true }, { text: "add feature", completed: false }];
    expect(diffTodos(parent, worktree)).toEqual(["add feature"]);
  });
  it("returns empty when nothing new", () => {
    expect(diffTodos([{ text: "x", completed: false }], [{ text: "x", completed: false }])).toEqual([]);
  });
  it("returns all when parent empty", () => {
    expect(diffTodos([], [{ text: "a", completed: false }, { text: "b", completed: false }])).toEqual(["a", "b"]);
  });
});

describe("diffManualSteps", () => {
  const e = (date: string, slug: string, title: string) => ({ date, featureSlug: slug, title, steps: [] });
  it("returns entries in worktree not in parent", () => {
    const result = diffManualSteps(
      [e("2026-04-01 10:00", "auth", "Setup auth")],
      [e("2026-04-01 10:00", "auth", "Setup auth"), e("2026-04-10 12:00", "feat-x", "Setup X")]
    );
    expect(result).toHaveLength(1);
    expect(result[0].featureSlug).toBe("feat-x");
  });
  it("returns empty when nothing new", () => {
    const entry = e("2026-04-01", "a", "T");
    expect(diffManualSteps([entry], [entry])).toHaveLength(0);
  });
});

describe("diffInsights", () => {
  const ins = (id: string) => ({ id, content: "x", sessionId: "s1", date: "2026-04-01", project: "p", projectPath: "/p" });
  it("returns insights not in parent ids", () => {
    const result = diffInsights(new Set(["abc123"]), [ins("abc123"), ins("def456")]);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("def456");
  });
  it("returns all when parent empty", () => {
    expect(diffInsights(new Set(), [ins("a"), ins("b")])).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Verify FAIL** — `npm test -- --reporter=verbose 2>&1 | grep -A3 "worktreeSync"`

- [ ] **Step 3: Create `src/lib/worktreeSync.ts`**

```ts
import { TodoItem, ManualStepEntry, InsightEntry } from "./types";

export function diffTodos(parentItems: TodoItem[], worktreeItems: TodoItem[]): string[] {
  const parentTexts = new Set(parentItems.map((i) => i.text));
  return worktreeItems.filter((i) => !parentTexts.has(i.text)).map((i) => i.text);
}

export function diffManualSteps(parentEntries: ManualStepEntry[], worktreeEntries: ManualStepEntry[]): ManualStepEntry[] {
  const key = (e: ManualStepEntry) => `${e.date}|${e.featureSlug}|${e.title}`;
  const parentKeys = new Set(parentEntries.map(key));
  return worktreeEntries.filter((e) => !parentKeys.has(key(e)));
}

export function diffInsights(parentIds: Set<string>, worktreeEntries: InsightEntry[]): InsightEntry[] {
  return worktreeEntries.filter((e) => !parentIds.has(e.id));
}
```

- [ ] **Step 4: Run all tests** — `npm test 2>&1 | tail -6` — expect 13 files passing.

- [ ] **Step 5: Commit** — `git add src/lib/worktreeSync.ts tests/worktreeSync.test.ts && git commit -m "feat: add worktreeSync diff utilities"`

---

## Task 5: Create GET /api/worktrees/[slug]

**Files:** Create `src/app/api/worktrees/[slug]/route.ts`

- [ ] **Step 1: Create directory** — `mkdir -p "src/app/api/worktrees/[slug]"`

- [ ] **Step 2: Create route.ts**

```ts
import { NextRequest, NextResponse } from "next/server";
import { getCachedScan } from "@/lib/cache";
import { checkWorktreeStatus } from "@/lib/worktreeChecker";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const scan = getCachedScan();
  if (!scan) return NextResponse.json({ error: "Scan cache not ready" }, { status: 503 });
  const project = scan.projects.find((p) => p.slug === slug);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (!project.worktrees || project.worktrees.length === 0) return NextResponse.json([]);

  const worktreeSlugFor = (branch: string) => `${slug}:wt:${branch.replace(/\//g, "-")}`;
  const statuses = await Promise.all(
    project.worktrees.map((wt) =>
      checkWorktreeStatus(project.path, wt.worktreePath, wt.branch, worktreeSlugFor(wt.branch))
    )
  );
  return NextResponse.json(statuses);
}
```

- [ ] **Step 3: Verify build** — `npm run build 2>&1 | tail -5`

- [ ] **Step 4: Commit** — `git add "src/app/api/worktrees/" && git commit -m "feat: add GET /api/worktrees/[slug]"`

---

## Task 6: Add POST to /api/worktrees/[slug] (start-server + remove)

**Files:** Modify `src/app/api/worktrees/[slug]/route.ts`

- [ ] **Step 1: Replace the import block with**

```ts
import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import { getCachedScan } from "@/lib/cache";
import { checkWorktreeStatus } from "@/lib/worktreeChecker";
import { processManager, findFreePort } from "@/lib/processManager";

const execFileAsync = promisify(execFile);
```

- [ ] **Step 2: Add POST handler after the GET export**

```ts
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = (await req.json()) as {
    action: "start-server" | "remove";
    worktreePath: string;
    parentDevPort?: number;
  };

  const scan = getCachedScan();
  if (!scan) return NextResponse.json({ error: "Scan cache not ready" }, { status: 503 });
  const project = scan.projects.find((p) => p.slug === slug);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  const wt = project.worktrees?.find((w) => w.worktreePath === body.worktreePath);
  if (!wt) return NextResponse.json({ error: "Worktree not found" }, { status: 404 });

  const worktreeSlug = `${slug}:wt:${wt.branch.replace(/\//g, "-")}`;

  if (body.action === "start-server") {
    const startPort = (body.parentDevPort ?? project.devPort ?? 3000) + 1;
    const port = await findFreePort(startPort);
    if (!port) return NextResponse.json({ error: `No free port from ${startPort}` }, { status: 409 });
    const info = await processManager.start(worktreeSlug, body.worktreePath, port);
    return NextResponse.json({ ...info, resolvedPort: port });
  }

  if (body.action === "remove") {
    const status = await checkWorktreeStatus(project.path, body.worktreePath, wt.branch, worktreeSlug);
    if (!status.isStale) {
      return NextResponse.json({ error: "Worktree is not stale — cannot remove automatically" }, { status: 400 });
    }
    try {
      const { stdout, stderr } = await execFileAsync(
        "git", ["worktree", "remove", body.worktreePath],
        { cwd: project.path, timeout: 10000 }
      );
      return NextResponse.json({ removed: true, output: stdout || stderr });
    } catch (err: unknown) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 409 });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
```

- [ ] **Step 3: Verify build** — `npm run build 2>&1 | tail -5`

- [ ] **Step 4: Commit** — `git add "src/app/api/worktrees/[slug]/route.ts" && git commit -m "feat: add POST /api/worktrees/[slug]"`

---

## Task 7: Create POST /api/worktrees/[slug]/sync

**Files:** Create `src/app/api/worktrees/[slug]/sync/route.ts`

- [ ] **Step 1: Create directory** — `mkdir -p "src/app/api/worktrees/[slug]/sync"`

- [ ] **Step 2: Create sync/route.ts**

```ts
import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { getCachedScan } from "@/lib/cache";
import { scanTodoMd } from "@/lib/scanner/todoMd";
import { scanManualStepsMd } from "@/lib/scanner/manualStepsMd";
import { scanInsightsMd, parseInsightsMd, appendInsights } from "@/lib/scanner/insightsMd";
import { appendTodosToFile } from "@/lib/todoWriter";
import { diffTodos, diffManualSteps, diffInsights } from "@/lib/worktreeSync";
import { ManualStepEntry } from "@/lib/types";

function entryToMarkdown(entry: ManualStepEntry): string {
  const steps = entry.steps.map((step) => {
    const checkbox = step.completed ? "- [x]" : "- [ ]";
    const details = step.details.map((d) => `  ${d}`).join("\n");
    return details ? `${checkbox} ${step.text}\n${details}` : `${checkbox} ${step.text}`;
  }).join("\n");
  return `## ${entry.date} | ${entry.featureSlug} | ${entry.title}\n\n${steps}\n\n---\n`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const { slug } = await params;
  const body = (await req.json()) as { worktreePath: string; file: "todos" | "manual-steps" | "insights" };
  const scan = getCachedScan();
  if (!scan) return NextResponse.json({ error: "Scan cache not ready" }, { status: 503 });
  const project = scan.projects.find((p) => p.slug === slug);
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  if (body.file === "todos") {
    const [parentInfo, worktreeInfo] = await Promise.all([scanTodoMd(project.path), scanTodoMd(body.worktreePath)]);
    const newTexts = diffTodos(parentInfo?.items ?? [], worktreeInfo?.items ?? []);
    if (newTexts.length === 0) return NextResponse.json({ synced: 0 });
    await appendTodosToFile(project.path, newTexts);
    return NextResponse.json({ synced: newTexts.length });
  }

  if (body.file === "manual-steps") {
    const [parentInfo, worktreeInfo] = await Promise.all([scanManualStepsMd(project.path), scanManualStepsMd(body.worktreePath)]);
    const newEntries = diffManualSteps(parentInfo?.entries ?? [], worktreeInfo?.entries ?? []);
    if (newEntries.length === 0) return NextResponse.json({ synced: 0 });
    const filePath = path.join(project.path, "MANUAL_STEPS.md");
    let existing = "";
    try { existing = await fs.readFile(filePath, "utf-8"); } catch { /* new file */ }
    const sep = existing.trimEnd() ? "\n\n" : "";
    await fs.writeFile(filePath, existing.trimEnd() + sep + newEntries.map(entryToMarkdown).join("\n"), "utf-8");
    return NextResponse.json({ synced: newEntries.length });
  }

  if (body.file === "insights") {
    const worktreeInfo = await scanInsightsMd(body.worktreePath);
    if (!worktreeInfo || worktreeInfo.entries.length === 0) return NextResponse.json({ synced: 0 });
    let parentContent = "";
    try { parentContent = await fs.readFile(path.join(project.path, "INSIGHTS.md"), "utf-8"); } catch { /* new */ }
    const { knownIds } = parseInsightsMd(parentContent);
    const newEntries = diffInsights(knownIds, worktreeInfo.entries);
    if (newEntries.length === 0) return NextResponse.json({ synced: 0 });
    await appendInsights(project.path, newEntries);
    return NextResponse.json({ synced: newEntries.length });
  }

  return NextResponse.json({ error: "Unknown file type" }, { status: 400 });
}
```

- [ ] **Step 3: Verify build** — `npm run build 2>&1 | tail -5`

- [ ] **Step 4: Commit** — `git add "src/app/api/worktrees/[slug]/sync/" && git commit -m "feat: add POST /api/worktrees/[slug]/sync"`


---

## Task 8: Create WorktreePanel.tsx

**Files:** Create `src/components/WorktreePanel.tsx`

- [ ] **Step 1: Create `src/components/WorktreePanel.tsx`**

```tsx
"use client";
import { useState, useCallback, useEffect } from "react";
import { WorktreeOverlay, WorktreeStatus } from "@/lib/types";

interface WorktreePanelProps {
  slug: string;
  devPort?: number;
  worktrees: WorktreeOverlay[];
}

type SyncFile = "todos" | "manual-steps" | "insights";

interface DevServerState { running: boolean; port?: number; loading: boolean; }
interface SyncState { loading: boolean; result?: number; error?: string; }

interface WorktreeRowProps {
  wt: WorktreeOverlay;
  status: WorktreeStatus;
  parentSlug: string;
  parentDevPort?: number;
  onRemoved: () => void;
}

function worktreeSlugFor(parentSlug: string, branch: string) {
  return `${parentSlug}:wt:${branch.replace(/\//g, "-")}`;
}

function WorktreeRow({ wt, status, parentSlug, parentDevPort, onRemoved }: WorktreeRowProps) {
  const wtSlug = worktreeSlugFor(parentSlug, wt.branch);
  const [devServer, setDevServer] = useState<DevServerState>({ running: false, loading: false });
  const [serverAction, setServerAction] = useState<"starting" | "stopping" | null>(null);
  const [syncState, setSyncState] = useState<Record<SyncFile, SyncState>>({
    todos: { loading: false },
    "manual-steps": { loading: false },
    insights: { loading: false },
  });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const refreshDevServer = useCallback(async () => {
    setDevServer((s) => ({ ...s, loading: true }));
    try {
      const res = await fetch(`/api/dev-server/${encodeURIComponent(wtSlug)}`);
      if (res.ok) {
        const data = await res.json();
        setDevServer({ running: data.running === true, port: data.port, loading: false });
      } else {
        setDevServer({ running: false, loading: false });
      }
    } catch {
      setDevServer({ running: false, loading: false });
    }
  }, [wtSlug]);

  useEffect(() => { refreshDevServer(); }, [refreshDevServer]);

  const handleStart = async () => {
    setServerAction("starting");
    try {
      const res = await fetch(`/api/worktrees/${parentSlug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "start-server", worktreePath: wt.worktreePath, parentDevPort }),
      });
      if (res.ok) await refreshDevServer();
    } finally {
      setServerAction(null);
    }
  };

  const handleStop = async () => {
    setServerAction("stopping");
    try {
      await fetch(`/api/dev-server/${encodeURIComponent(wtSlug)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "stop" }),
      });
      await refreshDevServer();
    } finally {
      setServerAction(null);
    }
  };

  const handleSync = async (file: SyncFile) => {
    setSyncState((s) => ({ ...s, [file]: { loading: true } }));
    try {
      const res = await fetch(`/api/worktrees/${parentSlug}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktreePath: wt.worktreePath, file }),
      });
      if (res.ok) {
        const data = await res.json();
        setSyncState((s) => ({ ...s, [file]: { loading: false, result: data.synced } }));
      } else {
        setSyncState((s) => ({ ...s, [file]: { loading: false, error: "Sync failed" } }));
      }
    } catch {
      setSyncState((s) => ({ ...s, [file]: { loading: false, error: "Network error" } }));
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    setRemoveError(null);
    try {
      const res = await fetch(`/api/worktrees/${parentSlug}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "remove", worktreePath: wt.worktreePath }),
      });
      if (res.ok) {
        onRemoved();
      } else {
        const data = await res.json();
        setRemoveError(data.error ?? "Remove failed");
        setRemoving(false);
      }
    } catch {
      setRemoveError("Network error");
      setRemoving(false);
    }
  };

  const lastCommit = status.lastCommitDate
    ? new Date(status.lastCommitDate).toLocaleDateString()
    : null;

  const syncItems: { file: SyncFile; label: string; has: boolean }[] = [
    { file: "todos", label: "TODOs", has: (wt.todos?.total ?? 0) > 0 },
    { file: "manual-steps", label: "Manual Steps", has: (wt.manualSteps?.totalSteps ?? 0) > 0 },
    { file: "insights", label: "Insights", has: (wt.insights?.total ?? 0) > 0 },
  ];

  return (
    <div style={{ border: "1px solid var(--border-subtle)", borderRadius: "var(--radius)", padding: "12px 14px" }}>
      {/* Branch header */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "10px" }}>
        <code style={{ fontSize: "0.78rem", color: "var(--text-primary)", background: "var(--bg-muted)", padding: "1px 6px", borderRadius: "3px" }}>
          {wt.branch}
        </code>
        {lastCommit && <span style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>{lastCommit}</span>}
        {status.isStale && (
          <span style={{ fontSize: "0.68rem", color: "var(--accent)", fontWeight: 500, marginLeft: "auto" }}>Stale</span>
        )}
      </div>

      {/* Dev server */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
        <span style={{ fontSize: "0.72rem", color: "var(--text-muted)", width: "80px" }}>Dev server</span>
        {devServer.loading ? (
          <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>…</span>
        ) : devServer.running ? (
          <>
            <span style={{ fontSize: "0.72rem", color: "var(--success, #4ade80)", fontFamily: "var(--font-mono)" }}>
              ● :{devServer.port}
            </span>
            <a
              href={`http://localhost:${devServer.port}`}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}
              onClick={(e) => e.stopPropagation()}
            >
              localhost:{devServer.port}
            </a>
            <button
              onClick={handleStop}
              disabled={serverAction !== null}
              style={{ fontSize: "0.7rem", padding: "1px 8px", borderRadius: "3px", border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
            >
              {serverAction === "stopping" ? "…" : "Stop"}
            </button>
          </>
        ) : (
          <button
            onClick={handleStart}
            disabled={serverAction !== null}
            style={{ fontSize: "0.7rem", padding: "1px 8px", borderRadius: "3px", border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer" }}
          >
            {serverAction === "starting" ? "Starting…" : "Start"}
          </button>
        )}
      </div>

      {/* Sync badges */}
      {syncItems.some((s) => s.has) && (
        <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", marginBottom: "8px" }}>
          {syncItems.map(({ file, label, has }) => {
            if (!has) return null;
            const s = syncState[file];
            const done = s.result !== undefined;
            return (
              <div key={file} style={{ display: "flex", alignItems: "center", gap: "4px" }}>
                <span style={{
                  fontSize: "0.68rem", padding: "1px 5px", borderRadius: "3px",
                  background: done ? "color-mix(in srgb, var(--success, #4ade80) 15%, transparent)" : "var(--accent-muted, rgba(245,158,11,0.12))",
                  color: done ? "var(--success, #4ade80)" : "var(--accent)",
                }}>
                  {done ? (s.result === 0 ? `${label} in sync` : `${label} +${s.result}`) : `${label} out of sync`}
                </span>
                {!done && (
                  <button
                    onClick={() => handleSync(file)}
                    disabled={s.loading}
                    style={{ fontSize: "0.68rem", padding: "1px 6px", borderRadius: "3px", border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer" }}
                  >
                    {s.loading ? "…" : "Sync to parent"}
                  </button>
                )}
                {s.error && <span style={{ fontSize: "0.68rem", color: "var(--destructive)" }}>{s.error}</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Remove (stale only) */}
      {status.isStale && !confirmRemove && (
        <button
          onClick={() => setConfirmRemove(true)}
          style={{ fontSize: "0.7rem", padding: "2px 10px", borderRadius: "3px", border: "1px solid var(--destructive)", background: "transparent", color: "var(--destructive)", cursor: "pointer" }}
        >
          Remove worktree
        </button>
      )}
      {confirmRemove && (
        <div style={{ marginTop: "6px", padding: "10px", background: "var(--bg-muted)", borderRadius: "var(--radius)", fontSize: "0.75rem" }}>
          <p style={{ margin: "0 0 6px", color: "var(--text-primary)" }}>
            Remove <code>{wt.branch}</code>?
            {status.uncommittedCount > 0 && (
              <span style={{ color: "var(--accent)" }}> Has {status.uncommittedCount} uncommitted changes.</span>
            )}
            {lastCommit && <span> Last commit {lastCommit}.</span>}
          </p>
          {removeError && <p style={{ margin: "0 0 6px", color: "var(--destructive)" }}>{removeError}</p>}
          <div style={{ display: "flex", gap: "6px" }}>
            <button
              onClick={handleRemove}
              disabled={removing}
              style={{ fontSize: "0.7rem", padding: "2px 10px", borderRadius: "3px", border: "none", background: "var(--destructive)", color: "white", cursor: "pointer" }}
            >
              {removing ? "Removing…" : "Confirm Remove"}
            </button>
            <button
              onClick={() => { setConfirmRemove(false); setRemoveError(null); }}
              disabled={removing}
              style={{ fontSize: "0.7rem", padding: "2px 10px", borderRadius: "3px", border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-muted)", cursor: "pointer" }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function WorktreePanel({ slug, devPort, worktrees }: WorktreePanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [statuses, setStatuses] = useState<WorktreeStatus[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchStatuses = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/worktrees/${slug}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatuses(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [slug]);

  const handleExpand = () => {
    if (!expanded && !statuses && !loading) fetchStatuses();
    setExpanded((x) => !x);
  };

  if (!worktrees || worktrees.length === 0) return null;

  return (
    <div>
      <button
        onClick={handleExpand}
        style={{ display: "flex", alignItems: "center", gap: "6px", background: "none", border: "none", cursor: "pointer", padding: 0 }}
      >
        <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>{expanded ? "▾" : "▸"}</span>
        <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-primary)" }}>
          Worktrees ({worktrees.length})
        </span>
      </button>

      {expanded && (
        <div style={{ marginTop: "12px", display: "flex", flexDirection: "column", gap: "10px" }}>
          {loading && <span style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>Loading…</span>}
          {error && (
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontSize: "0.8rem", color: "var(--destructive)" }}>{error}</span>
              <button
                onClick={fetchStatuses}
                style={{ fontSize: "0.72rem", padding: "2px 8px", borderRadius: "3px", border: "1px solid var(--border-subtle)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer" }}
              >
                Retry
              </button>
            </div>
          )}
          {statuses && worktrees.map((wt, i) => (
            <WorktreeRow
              key={wt.worktreePath}
              wt={wt}
              status={statuses[i]}
              parentSlug={slug}
              parentDevPort={devPort}
              onRemoved={fetchStatuses}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify build** — `npm run build 2>&1 | tail -5` — expect no type errors.

- [ ] **Step 3: Commit** — `git add src/components/WorktreePanel.tsx && git commit -m "feat: add WorktreePanel component"`


---

## Task 9: Wire WorktreePanel into ProjectDetail.tsx

**Files:** Modify `src/components/ProjectDetail.tsx`

- [ ] **Step 1: Add import at the top of ProjectDetail.tsx** (after the existing imports, before the first component definition)

Find the existing import block that includes `DevServerControl` (around line 7):
```ts
import { DevServerControl } from "./DevServerControl";
```
Add immediately after it:
```ts
import { WorktreePanel } from "./WorktreePanel";
```

- [ ] **Step 2: Add WorktreePanel in the Overview tab after DevServerControl**

Find the `<DevServerControl` block in the overview tab (around line 548):
```tsx
              <DevServerControl
                slug={project.slug}
                projectPath={project.path}
                devPort={devPort}
              />
```
Add immediately after the closing `/>`:
```tsx

              {project.worktrees && project.worktrees.length > 0 && (
                <WorktreePanel
                  slug={project.slug}
                  devPort={devPort}
                  worktrees={project.worktrees}
                />
              )}
```

- [ ] **Step 3: Verify build** — `npm run build 2>&1 | tail -5`

- [ ] **Step 4: Commit** — `git add src/components/ProjectDetail.tsx && git commit -m "feat: wire WorktreePanel into project overview"`


---

## Task 10: Add worktree count badge to ProjectCard.tsx

**Files:** Modify `src/components/ProjectCard.tsx`

The card already aggregates worktree counts for todos/steps/insights. Add a simple `wt N` badge near the dev server footer so users can see at a glance which cards have active worktrees.

- [ ] **Step 1: Add worktreeCount variable after the existing `insightsTotal` block (around line 52)**

Find this block:
```ts
  const hasAttention = pendingTodos > 0 || pendingSteps > 0;
```
Add before it:
```ts
  const worktreeCount = (project.worktrees ?? []).length;
```

- [ ] **Step 2: Add badge in the port/dev-server footer row**

In the footer section, find the port info `<div>` containing `<PortEditor` (around line 228):
```tsx
            {/* Port info */}
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.72rem", color: "var(--text-secondary)" }}>
                <PortEditor
```
Directly after the closing `</span>` of that PortEditor span (after the `{project.dbPort && ...}` block), before the closing `</div>` of the port info div, add:
```tsx
              {worktreeCount > 0 && (
                <span
                  style={{
                    fontSize: "0.68rem",
                    fontFamily: "var(--font-mono)",
                    color: "#60a5fa",
                    background: "rgba(96,165,250,0.12)",
                    padding: "1px 5px",
                    borderRadius: "3px",
                  }}
                >
                  wt {worktreeCount}
                </span>
              )}
```

- [ ] **Step 3: Verify build** — `npm run build 2>&1 | tail -5`

- [ ] **Step 4: Commit** — `git add src/components/ProjectCard.tsx && git commit -m "feat: add worktree count badge to project card"`


---

## Task 11: Final verification

**Files:** None — run tests and manual browser validation.

- [ ] **Step 1: Run full test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: all tests pass, including the 3 new test files (`findFreePort`, `worktreeChecker`, `worktreeSync`). Total should be 13 test files.

- [ ] **Step 2: Production build**

```bash
npm run build 2>&1 | tail -10
```

Expected: no TypeScript errors, no missing exports.

- [ ] **Step 3: Start dev server and verify WorktreePanel**

```bash
npm run dev
```

Open `http://localhost:4100` and navigate to a project that has worktrees (look for cards showing `wt N` blue badge).

Verify on the project detail page:
- [ ] Overview tab shows a "Worktrees (N)" collapsible section below DevServerControl
- [ ] Clicking expands and shows a skeleton/loading state, then per-worktree rows
- [ ] Each row shows branch name in monospace badge + last commit date
- [ ] Dev server row shows Start button; clicking it starts a server on the next free port
- [ ] When server running: shows green `● :PORT`, localhost link, Stop button
- [ ] Sync badges appear for file types that have content in the worktree
- [ ] "Sync to parent" button calls sync and shows `+N` or "in sync" result
- [ ] Stale worktrees show amber "Stale" badge and "Remove worktree" button
- [ ] Remove opens confirmation with branch name, last commit date, uncommitted count
- [ ] Confirming remove calls git and refreshes the panel
- [ ] Dashboard cards for projects with worktrees show blue `wt N` badge

- [ ] **Step 4: Commit final state if any loose changes**

```bash
git status
git add -A && git commit -m "feat: worktree support — dev server, sync, stale cleanup"
```

