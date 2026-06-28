# Portfolio Command Deck — Phase 2 Implementation Plan (MCP write-bridge + task bridge)

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Parent plan:** This is the task-by-task implementation of **Phase 2** of `docs/superpowers/plans/2026-06-25-portfolio-command-deck.md` (the roadmap, §7 "Phase 2 — MCP write-bridge"). The roadmap locks the *decisions*; this doc locks the *tasks, files, and code*. When in conflict, the roadmap's data model wins over any convenience shape; **the live codebase wins over the roadmap on mechanics** (Phase 1 is now merged — its writer/parser/API are the substrate).

**Goal:** Let a running Claude Code session push work into Minder's board without leaving the terminal, and turn a board issue into an executable task. Two deliverables: (1) a **board→task bridge** — promote a `BOARD.md` issue into a row in `~/.minder/tasks.db` that the existing dispatcher runs, with a two-way lifecycle (promote → issue `doing`; task done → issue `done`); (2) the **MCP write-bridge** — four new tools on Minder's MCP server (`board_create_issue`, `board_log_finding`, `board_postpone`, `board_promote_to_task`) that an agent calls to create/triage/snooze/promote board items, all stamped with `~session:`/`@wt:` provenance and landing in the canonical main-tree `BOARD.md`.

**Architecture:** This phase is **almost entirely an adapter layer over already-merged, already-tested substrate.** Phase 1 shipped the board writer (`src/lib/boardWriter.ts`: `addIssue`/`setIssueStatus`/`promoteTodoToBoard`/… — canonical-resolve → file-lock → atomic-write → re-parse, with `assertStatus`/`assertPriority` enum guards), the parser (`scanner/boardMd.ts`, which already recognizes the `(finding)` prefix and `@wt:`/`~session:` tokens and round-trips them), and `POST /api/board/[slug]` (action dispatch + `invalidateCache`). The MCP server (`src/lib/mcp/server.ts`, SDK `@modelcontextprotocol/sdk@^1.29.0`) already has **three write tools** (`toggle-manual-step`, `refresh-git-status`, `refresh-catalog`) that call lib writers directly and `invalidateCache()` — so board write tools are a proven pattern, not new ground. The task subsystem (`src/lib/tasks/`) already has `delegateTodo` (TODO→task) and a `createTask` lib + a 30s dispatcher tick; the board bridge is a **parallel** path because board issues have no `TODO.md` line anchor.

**Tech Stack:** Next.js 16 App Router, TypeScript, Zod v3, `@modelcontextprotocol/sdk@^1.29.0`, `better-sqlite3`, Vitest. Package manager: **pnpm**. Verification gate per `CLAUDE.md`: `pnpm typecheck` + full `pnpm test` (report exact pass count), and `pnpm build` for UI/MCP wiring.

---

## Decisions baked into this plan

| # | Decision | Rationale |
|---|----------|-----------|
| P1 | **A new `promoteBoardIssueToTask` lib (`src/lib/tasks/boardDelegation.ts`), NOT `delegateTodo`** | `delegateTodo` is keyed to a `TODO.md` `lineNumber` (it auto-toggles that line on completion). Board issues have no line anchor and may be ephemeral. The board path stores `{sourceType:"board-issue", boardIssueId, projectPath, projectSlug, sessionId, worktree}` in `task.metadata` and reuses the lower-level `createTask`. |
| P2 | **Two-way lifecycle, best-effort** | Promote sets the issue to `doing` (it's now in flight); task completion sets it to `done`. Both are best-effort — a missing/edited issue (`BoardWriteError NOT_FOUND`) is swallowed, never failing the task. The existing `onTaskCompleteToggleTodo` is **guarded** to only toggle when `metadata.sourceFile === "TODO.md"` so a board task never tries to toggle a phantom TODO line. |
| P3 | **MCP tools call lib functions directly** (Phase 1 writer + P1 promote lib) — same as the 3 existing write tools | No HTTP loopback; `findProjectPathBySlug` resolves slug→parent path and the writer canonicalizes again internally (worktree-safe). Errors surface via the existing `errorResult()` (`isError:true`). |
| P4 | **Provenance is supplied by the agent as optional tool inputs** (`sessionId`, `worktree`) | The MCP transport is **stateless** (`sessionIdGenerator: undefined`), so a tool cannot auto-derive the calling session. Claude Code knows its own session id and cwd, so the tool takes them as optional inputs and threads them into the writer's `@wt:`/`~session:` fields (confirmed emitted by `formatIssueLine`). |
| P5 | **`board_log_finding` → `## Inbox`, status `triage`, `(finding) ` title prefix** | Matches the Phase 1 parser (test: "keeps the (finding) prefix on agent-pushed inbox lines"). `board_create_issue` targets an epic when `epicId` is given, else the Inbox. `board_postpone` = `setIssueStatus → backlog` (snooze-to-backlog; the board has no date field). |
| P6 | **Promote is also a `promoteToTask` action on `POST /api/board/[slug]`** | One lib (`promoteBoardIssueToTask`), three callers (MCP tool, the per-project Board tab button, any HTTP client) — single source of truth, mirroring how Phase 1's writer backs both the API and the (future) MCP path. |
| P7 | **Reuse Phase 1's writer-level enum guards** | `addIssue`/`setIssueStatus` already throw `BoardWriteError "BAD_VALUE"` for out-of-enum status/priority; MCP tools just surface that as `errorResult`. No re-validation duplicated in the tool layer beyond required-field presence. |

**Suggested PR boundaries** (each independently green under the verification gate):
- **PR 1 — Board→task bridge** (Group A): `promoteBoardIssueToTask` lib + completion-hook guard/sync + `promoteToTask` API action + tests. No MCP, no new UI. Self-contained: a board issue becomes a dispatcher task.
- **PR 2 — MCP write-bridge** (Group B): `tools/board.ts` (4 tools) + `server.ts` registration + MCP tests. Reuses PR 1's promote lib + Phase 1's writer.
- **PR 3 — UI affordance + docs** (Group C): "Promote to task" button on the Board tab, `docs/help/mcp-server.md` + `board.md`, CHANGELOG, CLAUDE.md, final verification.

---

# Group A — Board → task bridge (PR 1)

> Outcome: `promoteBoardIssueToTask(...)` turns a `BOARD.md` issue into a `~/.minder/tasks.db` row the dispatcher runs; the issue moves to `doing` on promote and `done` on completion; the existing TODO auto-toggle is guarded so board tasks don't touch `TODO.md`.

### Task A1: `promoteBoardIssueToTask` lib

**Files:**
- Create: `src/lib/tasks/boardDelegation.ts`
- Create: `tests/boardDelegation.test.ts`
- Reference (do not duplicate): `src/lib/tasks/todoDelegation.ts` (`delegateTodo` shape, `resolveProjectPath` security checks), `src/lib/tasks/store.ts` or wherever `createTask` lives (confirm import path), `src/lib/boardWriter.ts` (`setIssueStatus`, `BoardWriteError`), `src/lib/scanner/boardMd.ts` (`scanBoardMd`), `src/lib/canonicalProjectPath.ts` (`canonicalProjectDir`).

- [ ] **Step 1: Resolve, look up, create.**

```typescript
export interface PromoteBoardIssueInput {
  projectPath: string;          // parent project path (route/MCP resolves slug→path)
  issueId: string;              // ^i- id (without the caret)
  assignedSkill?: string;
  model?: string;
  priority?: number;            // 1–5 (task priority, not board priority)
  riskLevel?: "low" | "medium" | "high";
  sessionId?: string;           // provenance for task.metadata
}

export interface PromoteBoardIssueResult {
  taskId: number;
  board?: BoardInfo;            // re-parsed after the issue → doing write
}

export async function promoteBoardIssueToTask(
  input: PromoteBoardIssueInput,
): Promise<PromoteBoardIssueResult> {
  const dir = await canonicalProjectDir(input.projectPath);
  const board = await scanBoardMd(dir);
  const issue = findIssueById(board, input.issueId);     // search epics + inbox
  if (!issue) throw new BoardWriteError(`Issue ${input.issueId} not found`, "NOT_FOUND");

  const task = createTask({
    title: issue.title.slice(0, 120),
    description: issue.detail ?? issue.title,
    quadrant: "delegated-todo",
    priority: input.priority,
    assigned_skill: input.assignedSkill,
    model: input.model,
    risk_level: input.riskLevel,
    metadata: {
      sourceType: "board-issue",          // distinguishes from TODO.md (see A2)
      boardIssueId: input.issueId,
      projectPath: dir,
      projectSlug: path.basename(dir),
      sessionId: input.sessionId,
      worktree: issue.worktree,
    },
  });

  // Best-effort: reflect that the issue is now in flight.
  let updated = board;
  try {
    updated = await setIssueStatus(dir, input.issueId, "doing");
  } catch { /* issue raced away — task still created */ }

  return { taskId: task.id, board: updated };
}
```

> Confirm `createTask`'s real import + param names (the dispatcher map shows `createTask({title, description, quadrant, metadata, ...})`). If `createTask` JSON-stringifies `metadata` itself, pass the object; otherwise stringify. Match `delegateTodo`'s usage exactly.

- [ ] **Step 2: tests** (`tests/boardDelegation.test.ts`) — mock `fs` (board reads/writes) and the task store (`createTask`) like `tests/boardWriter.test.ts` + `tests/todoDelegation.test.ts`. Cover: found-issue creates a task with `sourceType:"board-issue"` + `boardIssueId` in metadata and flips the issue to `doing`; missing issue throws `NOT_FOUND` and creates **no** task; the `setIssueStatus` failure path still returns the `taskId` (best-effort).
- [ ] **Step 3: Verify + Commit** — `feat(board): promoteBoardIssueToTask — board issue → dispatcher task`

---

### Task A2: Completion hook — guard the TODO toggle + sync the board

**Files:**
- Modify: the task-completion handler (dispatcher map: `afterComplete → onTaskCompleteToggleTodo`, likely `src/lib/tasks/todoDelegation.ts` / `dispatcher.ts` — **locate `onTaskCompleteToggleTodo`**)
- Modify/Create tests alongside the existing completion test.

- [ ] **Step 1: Guard the TODO toggle.** `onTaskCompleteToggleTodo` must only toggle when the task came from `TODO.md`:

```typescript
const meta = parseMetadata(task.metadata);
if (meta?.sourceFile !== "TODO.md" || typeof meta.lineNumber !== "number") return;
```

(Today a board task has no `lineNumber`, so it likely no-ops — but make the intent explicit so a future metadata change can't accidentally toggle a phantom line.)

- [ ] **Step 2: Board completion sync.** Add a sibling best-effort step in `afterComplete`: when `meta.sourceType === "board-issue"`, set the issue to `done`:

```typescript
if (meta?.sourceType === "board-issue" && meta.boardIssueId && meta.projectPath) {
  try { await setIssueStatus(meta.projectPath, meta.boardIssueId, "done"); }
  catch { /* issue edited/removed — ignore */ }
}
```

- [ ] **Step 3: tests** — a board-sourced completed task sets its issue to `done` and does **not** call the TODO toggle; a TODO-sourced task still toggles (regression guard).
- [ ] **Step 4: Verify + Commit** — `feat(tasks): sync board issue status on task completion; guard TODO toggle`

---

### Task A3: `promoteToTask` API action

**Files:**
- Modify: `src/app/api/board/[slug]/route.ts` (add a `promoteToTask` case to the POST dispatch)

- [ ] **Step 1:** In the `switch (body.action)`, add:

```typescript
case "promoteToTask": {
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const result = await promoteBoardIssueToTask({
    projectPath,
    issueId: body.id,
    assignedSkill: body.assignedSkill,
    model: body.model,
    priority: body.priority,
    riskLevel: body.riskLevel,
    sessionId: body.sessionId,
  });
  invalidateCache();
  return NextResponse.json(result);   // { taskId, board }
}
```

(`BoardWriteError "NOT_FOUND"` already maps to 404 in the existing catch.)

- [ ] **Step 2: Verify + Commit** — `feat(board): POST /api/board/[slug] promoteToTask action`

---

# Group B — MCP write-bridge (PR 2)

> Outcome: an agent connected to Minder's MCP server can create issues, log findings, postpone, and promote-to-task — all writing the canonical `BOARD.md` with provenance.

### Task B1: `src/lib/mcp/tools/board.ts`

**Files:**
- Create: `src/lib/mcp/tools/board.ts`
- Reference: `src/lib/mcp/tools/manualSteps.ts` (the `toggle-manual-step` write tool — closest precedent), `src/lib/mcp/schemas.ts` (`SlugSchema`), `src/lib/mcp/result.ts` (`jsonResult`/`errorResult`).

- [ ] **Step 1:** `registerBoardTools(server)` registering four tools that call the lib directly, resolving `slug` via `findProjectPathBySlug` and `invalidateCache()` after each write:

```typescript
export function registerBoardTools(server: McpServer): void {
  // board_create_issue — epic (epicId) or Inbox; stamps provenance
  server.registerTool("board_create_issue", {
    title: "Create a board issue",
    description: "Add an issue to a project's BOARD.md — under an epic (epicId) or the Inbox. " +
      "Pass sessionId/worktree to stamp provenance.",
    inputSchema: {
      slug: SlugSchema,
      title: z.string().min(1).max(300),
      epicId: z.string().optional(),
      status: BoardStatusSchema.optional(),
      priority: BoardPrioritySchema.optional(),
      labels: z.array(z.string()).optional(),
      sessionId: z.string().optional(),
      worktree: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (a) => withProject(a.slug, async (p) => {
    const board = await addIssue(p, {
      title: a.title, epicId: a.epicId, status: a.status, priority: a.priority,
      labels: a.labels, sessionId: a.sessionId, worktree: a.worktree,
    });
    invalidateCache();
    return jsonResult(board);
  }));

  // board_log_finding — Inbox, triage, "(finding) " prefix
  server.registerTool("board_log_finding", { /* slug, finding, priority?, labels?, sessionId?, worktree? */ },
    async (a) => withProject(a.slug, async (p) => {
      const board = await addIssue(p, {
        title: `(finding) ${a.finding}`, status: "triage",
        priority: a.priority, labels: a.labels, sessionId: a.sessionId, worktree: a.worktree,
      });
      invalidateCache();
      return jsonResult(board);
    }));

  // board_postpone — move to backlog (snooze)
  server.registerTool("board_postpone", { /* slug, id, status? = "backlog" */ },
    async (a) => withProject(a.slug, async (p) => {
      const board = await setIssueStatus(p, a.id, a.status ?? "backlog");
      invalidateCache();
      return jsonResult(board);
    }));

  // board_promote_to_task — bridge into ~/.minder/tasks.db
  server.registerTool("board_promote_to_task", { /* slug, id, assignedSkill?, model?, priority?, riskLevel?, sessionId? */ },
    async (a) => withProject(a.slug, async (p) => {
      const result = await promoteBoardIssueToTask({ projectPath: p, issueId: a.id, /* … */ });
      invalidateCache();
      return jsonResult(result);
    }));
}
```

- [ ] **Step 2: shared helpers.** Add `withProject(slug, fn)` (resolve via `findProjectPathBySlug`, `errorResult` on miss, try/catch → `errorResult(err.message)` for `BoardWriteError`). Add `BoardStatusSchema`/`BoardPrioritySchema` to `src/lib/mcp/schemas.ts` (`z.enum([...])`).
- [ ] **Step 3: Verify + Commit** — `feat(mcp): board write tools (create_issue, log_finding, postpone, promote_to_task)`

---

### Task B2: Register in `server.ts`

**Files:** Modify `src/lib/mcp/server.ts`

- [ ] **Step 1:** `import { registerBoardTools } from "./tools/board";` and add `registerBoardTools(server);` alongside the other `register*Tools(server)` calls.
- [ ] **Step 2: Verify + Commit** — `feat(mcp): register board tools on the server`

---

### Task B3: MCP tests

**Files:**
- Modify/Create: `tests/mcpTools.test.ts` (or `tests/mcpBoardTools.test.ts`) — `InMemoryTransport` + `Client` against `buildMcpServerForTests()`.

- [ ] **Step 1:** With `fs` mocked (as in `tests/boardWriter.test.ts`) and the task store mocked, assert: `board_create_issue` adds an Inbox/epic issue; `board_log_finding` writes a `(finding) ` Inbox row at `triage` with `@wt:`/`~session:` provenance; `board_postpone` sets `backlog`; `board_promote_to_task` returns a `taskId`; an unknown slug → `isError:true`; an out-of-enum status → `isError:true` (surfaced `BAD_VALUE`). Correctness of the writer itself is already covered by Phase 1 + A1 unit tests — these assert the **tool→lib wiring + error surfacing**.
- [ ] **Step 2: Verify + Commit** — `test(mcp): board write tool coverage`

---

# Group C — UI affordance + docs + final verification (PR 3)

### Task C1: "Promote to task" on the Board tab

**Files:**
- Modify: `src/components/BoardTab.tsx` (add a per-issue "Promote" action → `POST /api/board/[slug]` `{action:"promoteToTask", id}`, then refetch; toast/inline confirm with the returned `taskId`).

- [ ] **Step 1:** Add the affordance to `IssueRow` (only for issues with a stable `^i-` id, like the status `<select>`). On success, surface "→ task #N" and refresh.
- [ ] **Step 2: Verify + Commit** — `feat(board): promote-to-task button on the Board tab`

### Task C2: Help docs

**Files:** Modify `docs/help/mcp-server.md` (+ `public/help/` mirror); Modify `docs/help/board.md` (+ mirror).

- [ ] **Step 1:** Document the four new MCP tools (inputs, provenance, Inbox/triage behavior, that promote bridges to the task dispatcher) in `mcp-server.md`; add a "Promote to task" + "Agent write-bridge" section to `board.md`. `cp` each to `public/help/`.
- [ ] **Step 2: Commit** — `docs(board): MCP write-bridge + promote-to-task help`

### Task C3: CHANGELOG + CLAUDE.md

**Files:** `CHANGELOG.md`, `CLAUDE.md`

- [ ] **Step 1: CHANGELOG `[Unreleased] > Added`** — a "Board MCP write-bridge + task bridge" entry (4 MCP tools, `promoteToTask` API action, `boardDelegation`, two-way lifecycle, provenance).
- [ ] **Step 2: CLAUDE.md** — under MCP, list the four `board_*` tools; under API Routes note the `promoteToTask` action; under Architecture add `src/lib/tasks/boardDelegation.ts`.
- [ ] **Step 3: Commit** — `docs: CHANGELOG + CLAUDE.md for the board write-bridge`

### Task C4: Final verification gate

- [ ] `pnpm typecheck` — clean.
- [ ] `pnpm test` — full suite green; **report exact pass count**.
- [ ] `pnpm build` — compiles (MCP route + Board tab).
- [ ] Manual: connect via MCP (or `curl` the `/api/mcp` tool-call), run `board_log_finding` → confirm a `(finding)` row lands in the canonical `BOARD.md` Inbox with provenance; `board_promote_to_task` → confirm a `pending` row appears in `~/.minder/tasks.db` and the issue flips to `doing`.
- [ ] Open PRs per the boundaries above (feature branch → PR; never push to `main`).

---

## Open items deferred to later phases (not Phase 2)

- **Per-project Operations panel** (roadmap Phase 3) — `OpsSummary` derive layer + `OPERATIONS.md` runbook + `OpsPanel`. Flag `scanOps`.
- **GitHub activity surface** (roadmap Phase 4) — `githubActivityCache` (gh CLI) + `/api/github-activity` + card/detail strip. Flag `githubActivity`.
- **Worktree-scoped task execution** — the board's `@wt:` is stored in task metadata as provenance, but routing a promoted task into `runWorktreeTask`/`swarm_id` is out of scope here (promote creates a classic task; worktree execution is a follow-up).
- **Inbox item typing (Permission/Decision/Action)** — Cyboflow's review-queue categories are noted as an *informing* shape; explicit typed Inbox items are a later refinement, not v1 of the bridge.
- **Optional SQLite board index** (Phase 1 Task C3) — still deferred; scan cache serves fine.
