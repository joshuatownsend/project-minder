# Portfolio Command Deck — Phase 1 Implementation Plan (Canonicalization + Board MVP)

> **For agentic workers:** REQUIRED SUB-SKILL — use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Parent plan:** This is the task-by-task implementation of **Phase 1** of `docs/superpowers/plans/2026-06-25-portfolio-command-deck.md` (the roadmap). The roadmap locks the *decisions*; this doc locks the *tasks, files, and code*. When in conflict, the roadmap's data model (§6) wins over any convenience shape; the live codebase wins over the roadmap on mechanics.

**Goal:** Ship (1) a **planning-canonicalization layer** so `TODO.md` / `MANUAL_STEPS.md` / `INSIGHTS.md` have one project-scoped truth in the main working tree — live across git worktrees, no merge noise; and (2) a **Board MVP** — a git-tracked `BOARD.md` per project with epics → issues, parsed into a hierarchical model, exposed via a cross-project `/board` page, a per-project Board tab, a card badge, and create/move/reorder/promote write APIs.

**Architecture:** `BOARD.md` is a new, distinct file from `TODO.md` (confirmed 2026-06-27: `TODO.md` stays the lightweight quick-capture inbox; the board is the structured epic/issue layer, with a one-way TODO→board promote path). The board is parsed by a new scanner module into `BoardInfo`, carried on `ProjectData.board`, and served cross-project from the **in-memory scan cache** — exactly like `/api/insights` does today (markdown features do *not* go through SQLite). A SQLite index (`board_epics` / `board_issues` / `board_issues_fts`) is an **optional accelerator** (Task C3), gated by `dbModeRequested()` with a scan-cache fallback, so the board fully works at `MINDER_USE_DB=0`. All writes resolve to the **canonical main-tree path** via a new `resolveCanonicalProjectPath()` helper and serialize through the existing `withFileLock()` + `writeFileAtomic()`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4 + hand-rolled UI primitives, `better-sqlite3` (optional dep), Vitest. Package manager: **pnpm**. Verification gate per `CLAUDE.md`: `pnpm typecheck` + `pnpm test` (not `next build`).

---

## Decisions baked into this plan

| # | Decision | Rationale |
|---|----------|-----------|
| P1 | **New `BOARD.md`**, not an extended `TODO.md` | Confirmed with operator 2026-06-27. Keeps the quick-capture inbox clean; structured grammar doesn't destabilize the existing `todoMd` parser. |
| P2 | **Stable IDs are random short slugs (`^e-`/`^i-` base36), NOT content hashes** | The roadmap requires IDs to survive title edits and reorders ("the indexer keys on these so reorder/edit tracks the same item"). A content hash changes on every edit, breaking identity. `INSIGHTS.md` may hash-for-dedup only because it is append-only/immutable; the board is mutable. |
| P3 | **Scan-cache is the working baseline; SQLite index is an optional accelerator** | `/api/insights`, todos, and manual-steps all serve cross-project views from `getCachedScan()`, never SQLite. The board matches that. Task C3 (DB tables + FTS) is additive and skippable. |
| P4 | **All writes resolve to the canonical main-tree path** (D2) | One project-scoped planning truth; worktree copies never touched → no merge noise. New `resolveCanonicalProjectPath()` reuses `worktrees.ts` parent resolution. |
| P5 | **`BOARD.md` is a living checklist with a `BOARD.archive.md` companion** | Reuses the shipped living-checklist convention (`TODO.archive.md`, `MANUAL_STEPS.archive.md`). The board's `done`/history lane reads the archive on-demand (like `scanTodoArchive`), not a new DB history table. |
| P6 | **Feature flag `scanBoard`, default-on, neutral when off** | Mirrors every other scanner flag; `getFlag(flags, "scanBoard")` returns `undefined` board when off. |

**Suggested PR boundaries** (each is independently green under the verification gate):
- **PR 1 — Canonicalization** (Tasks A1–A4): self-contained fix for the worktree-divergence pain; ships value with zero board code.
- **PR 2 — Board parser/writer + types** (Tasks B1–B3): pure logic, heavily tested, no UI.
- **PR 3 — Scanner + API (+ optional index)** (Tasks C1–C3): wires the board into the scan and HTTP surface.
- **PR 4 — UI + docs** (Tasks D1–D4, E1–E2): pages, tab, badge, nav, help, changelog.

---

# Group A — Planning canonicalization (PR 1)

> Outcome: every planning writer and the watcher resolve to the canonical main-tree file; the worktree overlay stops surfacing per-worktree *planning* copies (keeps *code* status). This is the "planning ⟂ branch" principle from roadmap §5.

> **Build-time decision (2026-06-27): PR 1 shipped additive-only.** While implementing, we found that Minder's API writers *already* resolve slugs to the parent `project.path`, and that the **worktree-sync feature shipped ~1 day earlier (PR #221)** already reconciles worktree planning into the parent (its overlay *shows* worktree planning + a sync button). Canonicalization (prevent-up-front) and sync (reconcile-after-the-fact) are complementary, so we **kept the sync route + overlay untouched** and implemented only **A1 + A2 + A4**. **A3 (stripping planning from the overlay / deprecating the sync route) was deliberately deferred** — revisit it only when the board provides the unified worktree-activity feed meant to replace those panels. Do **not** remove the sync route as part of this phase.

### Task A1: Canonical-path helper

**Files:**
- Create: `src/lib/canonicalProjectPath.ts`
- Create: `tests/canonicalProjectPath.test.ts`
- Reference (do not duplicate): `src/lib/scanner/worktrees.ts` (`WORKTREE_SEP` exported ~line 8; `readWorktreeBranch` ~line 20; `attachWorktreeOverlays` ~line 63), `src/lib/scanner/worktreeCheck.ts:3` (`WORKTREE_SEP = "--claude-worktrees-"`), `src/lib/config.ts:23` (`getDevRoots`).

- [ ] **Step 1: Create `src/lib/canonicalProjectPath.ts`**

The helper takes any directory (possibly a worktree checkout) and returns the canonical main-tree project directory. The naming convention is `{parentDirName}--claude-worktrees-{branchHint}`, so the canonical parent is the segment **before** `WORKTREE_SEP`, resolved inside a dev root.

```typescript
import path from "path";
import { WORKTREE_SEP } from "./scanner/worktrees";

export interface CanonicalResolution {
  /** Canonical main-tree project directory (absolute). */
  canonicalPath: string;
  /** True if the input was a worktree checkout that was redirected. */
  wasWorktree: boolean;
  /** Branch hint extracted from the worktree dir name, if any. */
  branchHint?: string;
}

/**
 * Resolve any project-ish cwd to its canonical main-tree project directory.
 *
 * Worktree dirs are named `{parent}--claude-worktrees-{branchHint}` and live as
 * siblings of the parent inside a dev root. Planning files (TODO/MANUAL_STEPS/
 * INSIGHTS/BOARD) are project-scoped, so all writers must target the parent.
 *
 * `devRoots` is required so we resolve against a real, contained location rather
 * than blindly string-trimming a path we don't own.
 */
export function resolveCanonicalProjectPath(
  cwd: string,
  devRoots: string[],
): CanonicalResolution {
  const dirName = path.basename(cwd);
  const sepIndex = dirName.indexOf(WORKTREE_SEP);

  if (sepIndex === -1) {
    // Not a worktree dir — already canonical.
    return { canonicalPath: path.resolve(cwd), wasWorktree: false };
  }

  const parentName = dirName.slice(0, sepIndex);
  const branchHint = dirName.slice(sepIndex + WORKTREE_SEP.length) || undefined;

  // Prefer a dev root that actually contains the parent; fall back to the
  // worktree's own parent directory (siblings live together).
  for (const root of devRoots) {
    const candidate = path.resolve(root, parentName);
    if (candidate.startsWith(path.resolve(root))) {
      return { canonicalPath: candidate, wasWorktree: true, branchHint };
    }
  }

  const sibling = path.resolve(path.dirname(cwd), parentName);
  return { canonicalPath: sibling, wasWorktree: true, branchHint };
}
```

> **Note:** `WORKTREE_SEP` is currently re-exported by `worktrees.ts:8` from `worktreeCheck.ts:3`. If the import creates a cycle (worktrees.ts is heavy), import directly from `./scanner/worktreeCheck` instead.

- [ ] **Step 2: Create `tests/canonicalProjectPath.test.ts`**

Pure function — no `fs` mock needed. Cover: (a) plain main-tree dir returns itself with `wasWorktree:false`; (b) `crew-leader--claude-worktrees-feature-x` → `crew-leader` with `wasWorktree:true`, `branchHint:"feature-x"`; (c) resolution prefers a dev root that contains the parent; (d) sibling fallback when no dev root matches.

```typescript
import { describe, it, expect } from "vitest";
import { resolveCanonicalProjectPath } from "../src/lib/canonicalProjectPath";

describe("resolveCanonicalProjectPath", () => {
  const roots = ["C:\\dev"];

  it("returns a non-worktree dir unchanged", () => {
    const r = resolveCanonicalProjectPath("C:\\dev\\crew-leader", roots);
    expect(r.wasWorktree).toBe(false);
    expect(r.canonicalPath).toBe("C:\\dev\\crew-leader");
  });

  it("redirects a worktree dir to its parent in the dev root", () => {
    const r = resolveCanonicalProjectPath(
      "C:\\dev\\crew-leader--claude-worktrees-feature-x",
      roots,
    );
    expect(r.wasWorktree).toBe(true);
    expect(r.branchHint).toBe("feature-x");
    expect(r.canonicalPath).toBe("C:\\dev\\crew-leader");
  });
});
```

- [ ] **Step 3: Verify** — `pnpm typecheck && pnpm test canonicalProjectPath`
- [ ] **Step 4: Commit** — `feat(canonical): add resolveCanonicalProjectPath helper`

---

### Task A2: Route the planning writers + watcher through the canonical helper

**Files:**
- Modify: `src/lib/todoWriter.ts` (`appendTodosToFile` ~line 36, `toggleTodoInFile` ~line 84 — both take `projectPath` and join the filename)
- Modify: `src/lib/scanner/insightsMd.ts` (`appendInsights` ~line 162 — takes `projectPath`)
- Modify: `src/lib/manualStepsWriter.ts` (`toggleStepInFile` ~line 6 — **takes a full `filePath`, not `projectPath` — asymmetric**)
- Modify: `src/lib/manualStepsWatcher.ts` (writer call sites; singleton ~lines 292–297)

> **Design:** The cleanest, lowest-risk approach is to canonicalize **at the resolution boundary** (where a slug or cwd becomes a path), not inside every writer. The API routes already resolve slug→main-tree path, so they are mostly correct today. The two real leak points are: (a) the **watcher**, which watches worktree `MANUAL_STEPS.md` files and toggles them by their watched `filePath`; and (b) any future cwd-based caller (the MCP tool in Phase 2). We harden the writers defensively so a worktree path can never slip through.

- [ ] **Step 1: Canonicalize inside the `projectPath`-taking writers**

In `appendTodosToFile`, `toggleTodoInFile`, and `appendInsights`, resolve the incoming `projectPath` before joining the filename:

```typescript
import { resolveCanonicalProjectPath } from "./canonicalProjectPath"; // adjust relative path
import { getDevRoots, loadConfig } from "./config";

// at the top of each writer, before path.join(projectPath, "TODO.md"):
const devRoots = getDevRoots(await loadConfig());
const { canonicalPath } = resolveCanonicalProjectPath(projectPath, devRoots);
const filePath = path.join(canonicalPath, "TODO.md"); // or INSIGHTS.md
```

> Keep this cheap: `loadConfig()` is already cached. If a writer is hot, accept an optional `devRoots?` param and thread it from the caller to avoid re-reading config.

- [ ] **Step 2: Handle the `toggleStepInFile` full-path asymmetry**

`toggleStepInFile(filePath, lineNumber)` receives a full path to a specific `MANUAL_STEPS.md`. For the **canonicalization fix**, the watcher must stop toggling the *worktree* copy. Add a sibling helper that canonicalizes the directory of the given file:

```typescript
// src/lib/manualStepsWriter.ts
import { resolveCanonicalProjectPath } from "./canonicalProjectPath";
import { getDevRoots, loadConfig } from "./config";

export async function toggleStepInFile(filePath: string, lineNumber: number) {
  const devRoots = getDevRoots(await loadConfig());
  const { canonicalPath } = resolveCanonicalProjectPath(path.dirname(filePath), devRoots);
  const canonicalFile = path.join(canonicalPath, path.basename(filePath));
  // ...existing read/lock/toggle/atomic-write logic, but against canonicalFile...
}
```

- [ ] **Step 3: Point the watcher's toggle path at the canonical file**

In `src/lib/manualStepsWatcher.ts`, anywhere a write is initiated for a worktree-watched file, ensure it flows through the updated `toggleStepInFile` (which now canonicalizes). The watcher may continue to *watch* worktree files for change detection, but *writes* land canonical.

- [ ] **Step 4: Verify** — `pnpm typecheck && pnpm test`
  Confirm existing `tests/todoWriter`/`insightsWriter` tests still pass (they pass main-tree paths, so canonicalization is a no-op for them). Add one test per writer proving a worktree-style `projectPath` redirects to the parent file.
- [ ] **Step 5: Commit** — `fix(canonical): route planning writers + watcher to canonical main-tree path`

---

### Task A3: Worktree overlay — drop per-worktree planning panels, keep code status

**Files:**
- Modify: `src/lib/scanner/worktrees.ts` (`attachWorktreeOverlays` ~line 63)
- Modify: `src/lib/types.ts` (`WorktreeOverlay` ~lines 483–489)
- Modify: any UI consumer of `overlay.todos/manualSteps/insights` (grep for `.worktrees` in `src/components/`)
- Modify: `tests/worktrees.test.ts`

- [ ] **Step 1: Slim the `WorktreeOverlay` type to code-only**

Per roadmap §5, planning is project-scoped — the overlay keeps *code* status (branch, path) and stops carrying planning copies.

```typescript
export interface WorktreeOverlay {
  branch: string;
  worktreePath: string;
  // REMOVED: todos?, manualSteps?, insights? — planning is canonical now.
  // (Optional, additive for later phases: ahead/behind, dirty counts.)
}
```

- [ ] **Step 2: Stop populating planning fields in `attachWorktreeOverlays`**

Remove the per-worktree `scanTodoMd` / `scanManualStepsMd` / `scanInsightsMd` reads. Keep branch resolution (`readWorktreeBranch`) and `worktreePath`. Worktree-origin provenance is now surfaced on the **board** via `@wt:<branch>` tags (Task B2/B3), not via duplicated planning panels.

- [ ] **Step 3: Update consumers**

Find UI that rendered `overlay.todos` etc. and either remove those sub-panels or repoint to the unified planning view. (Likely `ProjectDetail.tsx` / a worktree sub-component.)

- [ ] **Step 4: Verify** — `pnpm typecheck && pnpm test worktrees`
- [ ] **Step 5: Commit** — `refactor(worktrees): overlay carries code status only; planning is canonical`

---

### Task A4: Update `CLAUDE.md` agent instructions + CHANGELOG

**Files:**
- Modify: `C:\dev\project-minder\CLAUDE.md` (Manual Step Logging block ~lines 205–248)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Change "project root" → canonical project file in the Manual Step Logging block**

The block currently tells agents to write `MANUAL_STEPS.md` "in the project root." From a worktree, "project root" is ambiguous. Add a sentence: *"If you are working inside a git worktree (`…--claude-worktrees-…`), record manual steps, TODOs, and insights in the **canonical main-tree** copy of the project, not the worktree checkout — Minder treats planning as project-scoped. Minder's writers resolve this automatically; when editing by hand, target the parent project directory."*

- [ ] **Step 2: CHANGELOG `[Unreleased] > Changed`**

```markdown
- **Planning is now canonical to the main tree.** TODO.md / MANUAL_STEPS.md / INSIGHTS.md writes from a git worktree are redirected to the parent project's file, so planning stays project-scoped and worktrees no longer create divergent copies or merge noise. The worktree overlay now shows code status only.
```

- [ ] **Step 3: Commit** — `docs(canonical): instruct agents to log planning to the canonical project file`

---

# Group B — Board parser / writer / types (PR 2)

### Task B1: Types + feature flag

**Files:**
- Modify: `src/lib/types.ts` (add board types near the other `*Info` interfaces ~434–481; add `board?` to `ProjectData` ~lines 20–96 after `insights?`; add `"scanBoard"` to `FeatureFlagKey` ~lines 513–531)
- Modify: `src/lib/featureFlags.ts` (`FEATURE_FLAG_KEYS` ~lines 6–23; `FEATURE_FLAG_META` ~lines 41–189)

- [ ] **Step 1: Add the board model to `src/lib/types.ts` (roadmap §6.4 — hierarchical)**

```typescript
export type BoardStatus = "backlog" | "todo" | "doing" | "review" | "done" | "triage";
export type BoardPriority = "high" | "med" | "low";

export interface BoardIssue {
  id: string;                 // "i-xxxx" (may be "" until backfilled)
  title: string;
  status: BoardStatus;
  priority?: BoardPriority;
  labels: string[];
  epicId?: string;            // undefined for Inbox items
  worktree?: string;          // @wt:<branch> provenance
  sessionId?: string;         // ~session:<id> provenance
  detail?: string;            // indented detail lines, joined
  line: number;               // 1-based, for write-back
  order: number;              // 0-based within its container
}

export interface BoardEpic {
  id: string;                 // "e-xxxx"
  title: string;
  status: BoardStatus;
  priority?: BoardPriority;
  labels: string[];
  description?: string;       // leading `>` blockquote
  line: number;
  order: number;
  issues: BoardIssue[];
}

export interface BoardInfo {
  epics: BoardEpic[];
  inbox: BoardIssue[];        // items under `## Inbox`
  total: number;              // epics + all issues + inbox
}
```

- [ ] **Step 2: Add `board?` to `ProjectData`** (after `insights?: InsightsInfo;`):

```typescript
  board?: BoardInfo;
```

- [ ] **Step 3: Add the flag** — `"scanBoard"` to the `FeatureFlagKey` union, to `FEATURE_FLAG_KEYS`, and a `FEATURE_FLAG_META` entry:

```typescript
{
  key: "scanBoard",
  label: "Scan BOARD.md",
  description: "Reads BOARD.md (epics → issues) from each project for the Board.",
  group: "passive",
  appliesAt: "scan",
  wired: true,
},
```

- [ ] **Step 4: Verify** — `pnpm typecheck` (new types unused but valid)
- [ ] **Step 5: Commit** — `feat(board): add BoardInfo/BoardEpic/BoardIssue types + scanBoard flag`

---

### Task B2: Board parser + scanner module (`src/lib/scanner/boardMd.ts`)

**Files:**
- Create: `src/lib/scanner/boardMd.ts`
- Create: `tests/boardMd.test.ts`
- Reference: `src/lib/scanner/todoMd.ts` (`parseTodoMd` ~6, `scanTodoMd` ~33, `scanTodoArchive` ~49), `src/lib/scanner/insightsMd.ts` (parse pattern).

**The board grammar (canonical spec — roadmap §6.2).** The parser must be *tolerant of hand edits*: missing IDs, missing status tokens (derive from checkbox glyph), extra whitespace, and bare `- [ ] thing` lines.

```markdown
# Board — <project>
<!-- minder-board: v1 -->

## Epic: <title> ^e-<id>  [<status>]  !<priority>  @<tag>…
> <optional one-or-more blockquote description lines>

- [ ] <title> ^i-<id>  [<status>]  !<priority>  #<label>…  @wt:<branch>  ~session:<id>
  <optional indented detail lines>
- [>] <doing item> ^i-<id>  [doing]  #label
- [x] <done item> ^i-<id>  [done]

## Inbox
<!-- agent-pushed findings/todos land here for triage -->
- [ ] (finding) <title> ^i-<id>  [triage]  @wt:<branch>  ~session:<id>
```

Token rules:
- **ID:** `\^([ei])-([A-Za-z0-9]+)` → `e-<id>` / `i-<id>`. Absent ⇒ `id = ""` (writer backfills on next write).
- **Status:** `\[(backlog|todo|doing|review|done|triage)\]`. If absent, derive from the checkbox glyph: `[ ]`→`todo`, `[>]`→`doing`, `[x]`→`done`. Explicit `[status]` token wins over the glyph.
- **Priority:** `!(high|med|low)`.
- **Labels:** all `#([A-Za-z0-9][\w-]*)` matches.
- **Provenance:** `@wt:(\S+)` → `worktree`; `~session:(\S+)` → `sessionId`.
- **Epic tags:** `@(\S+)` that are *not* `@wt:` go into the epic's `labels`.
- **Title:** the line with the checkbox prefix and all the above tokens stripped, trimmed.

- [ ] **Step 1: Create `src/lib/scanner/boardMd.ts`**

```typescript
import { promises as fs } from "fs";
import path from "path";
import { BoardInfo, BoardEpic, BoardIssue, BoardStatus, BoardPriority } from "../types";

const ID_RE = /\^([ei])-([A-Za-z0-9]+)/;
const STATUS_RE = /\[(backlog|todo|doing|review|done|triage)\]/;
const PRIORITY_RE = /!(high|med|low)\b/;
const WT_RE = /@wt:(\S+)/;
const SESSION_RE = /~session:(\S+)/;
const LABEL_RE = /#([A-Za-z0-9][\w-]*)/g;
const EPIC_HEADER_RE = /^##\s+Epic:\s*(.*)$/i;
const INBOX_HEADER_RE = /^##\s+Inbox\b/i;
const ISSUE_RE = /^(\s*)-\s*\[([ x>])\]\s+(.*)$/i;

function glyphToStatus(glyph: string): BoardStatus {
  if (glyph.toLowerCase() === "x") return "done";
  if (glyph === ">") return "doing";
  return "todo";
}

/** Strip recognised tokens from a title fragment. */
function cleanTitle(s: string): string {
  return s
    .replace(ID_RE, "")
    .replace(STATUS_RE, "")
    .replace(PRIORITY_RE, "")
    .replace(WT_RE, "")
    .replace(SESSION_RE, "")
    .replace(LABEL_RE, "")
    .replace(/@\S+/g, "") // remaining epic tags already captured separately
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseLabels(s: string): string[] {
  const out: string[] = [];
  let m: RegExpExecArray | null;
  LABEL_RE.lastIndex = 0;
  while ((m = LABEL_RE.exec(s))) out.push(m[1]);
  return out;
}

/** Pure parse — no FS. Tolerant of missing IDs / status / hand edits. */
export function parseBoardMd(content: string): BoardInfo | undefined {
  const lines = content.split(/\r?\n/);
  const epics: BoardEpic[] = [];
  const inbox: BoardIssue[] = [];

  let currentEpic: BoardEpic | null = null;
  let inInbox = false;
  let lastIssue: BoardIssue | null = null;
  let epicOrder = 0;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();

    // Epic header
    const epicM = line.match(EPIC_HEADER_RE);
    if (epicM) {
      inInbox = false;
      lastIssue = null;
      const idM = line.match(ID_RE);
      const statusM = line.match(STATUS_RE);
      const prioM = line.match(PRIORITY_RE);
      const tags = (line.match(/@\S+/g) || [])
        .filter((t) => !t.startsWith("@wt:"))
        .map((t) => t.slice(1));
      currentEpic = {
        id: idM && idM[1] === "e" ? `e-${idM[2]}` : "",
        title: cleanTitle(epicM[1]),
        status: (statusM?.[1] as BoardStatus) ?? "backlog",
        priority: prioM?.[1] as BoardPriority | undefined,
        labels: tags,
        line: i + 1,
        order: epicOrder++,
        issues: [],
      };
      epics.push(currentEpic);
      continue;
    }

    // Inbox header
    if (INBOX_HEADER_RE.test(line)) {
      inInbox = true;
      currentEpic = null;
      lastIssue = null;
      continue;
    }

    // Epic description blockquote (immediately under an epic, before any issue)
    if (currentEpic && !lastIssue && /^\s*>\s?/.test(line)) {
      const text = line.replace(/^\s*>\s?/, "");
      currentEpic.description = currentEpic.description
        ? `${currentEpic.description}\n${text}`
        : text;
      continue;
    }

    // Issue line
    const issueM = line.match(ISSUE_RE);
    if (issueM) {
      const [, , glyph, rest] = issueM;
      const idM = rest.match(ID_RE);
      const statusM = rest.match(STATUS_RE);
      const prioM = rest.match(PRIORITY_RE);
      const wtM = rest.match(WT_RE);
      const sessM = rest.match(SESSION_RE);
      const container = inInbox ? inbox : currentEpic?.issues ?? inbox;
      const issue: BoardIssue = {
        id: idM && idM[1] === "i" ? `i-${idM[2]}` : "",
        title: cleanTitle(rest),
        status: (statusM?.[1] as BoardStatus) ?? glyphToStatus(glyph),
        priority: prioM?.[1] as BoardPriority | undefined,
        labels: parseLabels(rest),
        epicId: inInbox ? undefined : currentEpic?.id || undefined,
        worktree: wtM?.[1],
        sessionId: sessM?.[1],
        line: i + 1,
        order: container.length,
      };
      container.push(issue);
      lastIssue = issue;
      continue;
    }

    // Indented detail line under the last issue
    if (lastIssue && /^\s{2,}\S/.test(raw)) {
      const text = raw.trim();
      lastIssue.detail = lastIssue.detail ? `${lastIssue.detail}\n${text}` : text;
      continue;
    }

    // Blank or unrecognised line resets detail capture but not epic context
    if (line.trim() === "") lastIssue = null;
  }

  const total =
    epics.length +
    epics.reduce((n, e) => n + e.issues.length, 0) +
    inbox.length;

  if (total === 0) return undefined;
  return { epics, inbox, total };
}

/** Read BOARD.md from a project root. */
export async function scanBoardMd(projectPath: string): Promise<BoardInfo | undefined> {
  try {
    const content = await fs.readFile(path.join(projectPath, "BOARD.md"), "utf-8");
    return parseBoardMd(content);
  } catch {
    return undefined;
  }
}

/** On-demand read of BOARD.archive.md (done/history lane). Not called by the scan. */
export async function scanBoardArchive(projectPath: string): Promise<BoardInfo | undefined> {
  try {
    const content = await fs.readFile(path.join(projectPath, "BOARD.archive.md"), "utf-8");
    return parseBoardMd(content);
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 2: Create `tests/boardMd.test.ts`** (the highest-value tests — grammar coverage + parse stability)

Mirror `tests/todoMd.test.ts` structure (`vi.mock("fs")` for `scanBoardMd`; pure calls for `parseBoardMd`). Cover at minimum:
- epic + nested issues, IDs/status/priority/labels extracted;
- glyph-derived status when `[status]` token absent (`[>]`→doing, `[x]`→done);
- `## Inbox` items land in `inbox`, `epicId` undefined;
- provenance `@wt:` / `~session:` captured, `@wt:` excluded from labels;
- indented detail lines attach to the right issue;
- bare `- [ ] thing` (no ID, no status) parses with `id:""`, `status:"todo"`;
- empty/whitespace file → `undefined`;
- a `(finding)` inbox line parses (title keeps the `(finding)` prefix or strip — pick and assert).

- [ ] **Step 3: Verify** — `pnpm typecheck && pnpm test boardMd`
- [ ] **Step 4: Commit** — `feat(board): add BOARD.md parser + scanner module with tests`

---

### Task B3: Board writer (`src/lib/boardWriter.ts`)

**Files:**
- Create: `src/lib/boardWriter.ts`
- Create: `tests/boardWriter.test.ts`
- Reference: `src/lib/todoWriter.ts` (`withFileLock`, `writeFileAtomic`, re-parse-and-return pattern), `src/lib/tasks/todoDelegation.ts` (`delegateTodo` ~62 — promote pattern, later), `src/lib/canonicalProjectPath.ts` (Task A1).

> **Serializing writer (D2):** every mutation is canonical-path-resolved, file-locked, atomic-written, then re-parsed so the returned `BoardInfo` matches disk. Agent writes (Phase 2) are append-only; structural edits (move/reorder) go through here as the single serializer.

- [ ] **Step 1: Create `src/lib/boardWriter.ts` with ID generation + backfill**

```typescript
import { promises as fs } from "fs";
import path from "path";
import { BoardInfo, BoardStatus, BoardPriority } from "./types";
import { parseBoardMd } from "./scanner/boardMd";
import { resolveCanonicalProjectPath } from "./canonicalProjectPath";
import { getDevRoots, loadConfig } from "./config";
// import { withFileLock, writeFileAtomic } from "./fileLock"; // wherever these live (see todoWriter.ts)

/** Random short surrogate key — STABLE across edits (P2). Never a content hash. */
export function genBoardId(kind: "e" | "i", existing: Set<string>): string {
  let id: string;
  do {
    id = `${kind}-${Math.random().toString(36).slice(2, 6)}`;
  } while (existing.has(id));
  existing.add(id);
  return id;
}

const STATUS_GLYPH: Record<BoardStatus, string> = {
  backlog: " ",
  todo: " ",
  doing: ">",
  review: ">",
  done: "x",
  triage: " ",
};

/** Collect every ^e-/^i- id already present so generation avoids collisions. */
function collectIds(content: string): Set<string> {
  const ids = new Set<string>();
  for (const m of content.matchAll(/\^([ei]-[A-Za-z0-9]+)/g)) ids.add(m[1]);
  return ids;
}

/**
 * Insert a `^e-/^i-` block ref on any epic/issue line that lacks one.
 * Returns the (possibly) rewritten content and whether anything changed.
 */
export function backfillIds(content: string): { content: string; changed: boolean } {
  const ids = collectIds(content);
  const lines = content.split(/\r?\n/);
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isEpic = /^##\s+Epic:/i.test(line);
    const isIssue = /^\s*-\s*\[[ x>]\]\s+/i.test(line);
    if ((isEpic || isIssue) && !/\^[ei]-/.test(line)) {
      const id = genBoardId(isEpic ? "e" : "i", ids);
      // Insert the block ref after the title, before any status/priority/labels
      // tokens. Simplest robust rule: append before a trailing `[status]` if any,
      // else at end of the meaningful text.
      const statusIdx = line.search(/\[(backlog|todo|doing|review|done|triage)\]/);
      if (statusIdx !== -1) {
        lines[i] = `${line.slice(0, statusIdx).trimEnd()} ^${id}  ${line.slice(statusIdx)}`;
      } else {
        lines[i] = `${line.trimEnd()} ^${id}`;
      }
      changed = true;
    }
  }
  return { content: changed ? lines.join("\n") : content, changed };
}

async function canonicalBoardPath(projectPath: string): Promise<string> {
  const devRoots = getDevRoots(await loadConfig());
  const { canonicalPath } = resolveCanonicalProjectPath(projectPath, devRoots);
  return path.join(canonicalPath, "BOARD.md");
}

/** Read → mutate → backfill → atomic write → re-parse. Caller passes a transform. */
async function mutate(
  projectPath: string,
  transform: (content: string, ids: Set<string>) => string,
): Promise<BoardInfo | undefined> {
  const filePath = await canonicalBoardPath(projectPath);
  // return withFileLock(filePath, async () => {
  let content = "";
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    content = `# Board\n\n<!-- minder-board: v1 -->\n`;
  }
  const ids = collectIds(content);
  let next = transform(content, ids);
  next = backfillIds(next).content;
  // await writeFileAtomic(filePath, next);
  await fs.writeFile(filePath, next, "utf-8"); // replace with writeFileAtomic
  return parseBoardMd(next);
  // });
}
```

- [ ] **Step 2: Implement the public mutation API**

Implement these on top of `mutate()` (all canonical, locked, atomic, re-parsed). Keep each a focused string transform:

```typescript
export interface NewIssue {
  title: string;
  epicId?: string;             // omit ⇒ Inbox
  status?: BoardStatus;        // default "todo"
  priority?: BoardPriority;
  labels?: string[];
  worktree?: string;           // @wt:
  sessionId?: string;          // ~session:
}

export function addIssue(projectPath: string, issue: NewIssue): Promise<BoardInfo | undefined>;
export function addEpic(projectPath: string, title: string, opts?: { status?: BoardStatus; priority?: BoardPriority; description?: string }): Promise<BoardInfo | undefined>;
export function setIssueStatus(projectPath: string, id: string, status: BoardStatus): Promise<BoardInfo | undefined>;
export function moveIssue(projectPath: string, id: string, toEpicId: string | "inbox"): Promise<BoardInfo | undefined>;
export function reorderIssue(projectPath: string, id: string, newOrder: number): Promise<BoardInfo | undefined>;
export function editIssue(projectPath: string, id: string, patch: Partial<Pick<NewIssue, "title" | "priority" | "labels">>): Promise<BoardInfo | undefined>;
```

Implementation notes:
- **`addIssue`** — format the line `- [<glyph>] <title> [<status>] [!prio] [#labels…] [@wt:…] [~session:…]` and insert it as the last line of the target epic's block (find the epic header by `^e-<id>`, scan to the next `##`/EOF), or append under `## Inbox` (create the section if missing). Leave the `^i-` ref off — `backfillIds` adds it on write so IDs are always assigned by Minder.
- **`setIssueStatus`** — locate the line containing `^i-<id>`, replace the `[status]` token (insert if missing) **and** the checkbox glyph via `STATUS_GLYPH[status]`. This keeps glyph and token in sync (so the existing checkbox toggler and human readers agree).
- **`moveIssue` / `reorderIssue`** — delete the issue's line, re-insert at the target container/position. Because IDs are stable (P2), the index re-keys to the same item. Reorder = rewrite line order (Minder is the serializer).
- **`editIssue`** — patch tokens on the issue's line in place.

- [ ] **Step 3: (Optional, can defer to PR 3) `promoteTodoToBoard`**

Reuse the `delegateTodo` shape: read a `TODO.md` line, create a board issue from its text (default Inbox or a target epic), then optionally check off the TODO via `toggleTodoInFile`. This is the TODO→board promote path from §6.1.

```typescript
export async function promoteTodoToBoard(input: {
  projectPath: string;
  todoLineNumber: number;
  todoText: string;
  epicId?: string;
  checkOffTodo?: boolean;
}): Promise<BoardInfo | undefined>;
```

- [ ] **Step 4: Create `tests/boardWriter.test.ts`** — mock `fs`, assert on formatted output and on **round-trip stability**: `parseBoardMd(write(parseBoardMd(x)))` preserves IDs, status, ordering, and hand formatting. Cover ID backfill (bare line gets a fresh `^i-`; existing IDs untouched; no collisions), `setIssueStatus` syncs glyph+token, `addIssue` into epic vs Inbox, Inbox-section creation.
- [ ] **Step 5: Verify** — `pnpm typecheck && pnpm test boardWriter`
- [ ] **Step 6: Commit** — `feat(board): add serializing BOARD.md writer (add/move/status/reorder + ID backfill)`

> **Wire the real lock/atomic helpers in Step 1** — `todoWriter.ts` imports `withFileLock`/`writeFileAtomic`; use the same module rather than the placeholder `fs.writeFile`. This is what makes "Minder as the single serializing writer" (D2) real.

---

# Group C — Scanner integration + API (+ optional index) (PR 3)

### Task C1: Scanner integration

**Files:**
- Modify: `src/lib/scanner/index.ts` (imports ~lines 6–28; `Promise.all` in `scanProject` ~lines 155–189; project assembly ~lines 237–239)

- [ ] **Step 1: Import + flag-gated scan**

Add `import { scanBoardMd } from "./boardMd";`. In the per-project `Promise.all`, add a flag-gated entry mirroring the other passive scanners:

```typescript
getFlag(flags, "scanBoard") ? scanBoardMd(projectPath) : Promise.resolve(undefined),
```

- [ ] **Step 2: Assign to the project object** — add `board,` to the assembled `ProjectData`.
- [ ] **Step 3: Verify** — `pnpm typecheck && pnpm test`
- [ ] **Step 4: Commit** — `feat(board): wire scanBoardMd into the scanner orchestrator`

---

### Task C2: API routes (scan-cache baseline)

**Files:**
- Create: `src/app/api/board/route.ts` (GET cross-project)
- Create: `src/app/api/board/[slug]/route.ts` (GET per-project, POST mutate)
- Reference: `src/app/api/insights/route.ts` (GET-from-cache), `src/app/api/manual-steps/[slug]/route.ts` (POST + slug→path validation + `invalidateCache`).

- [ ] **Step 1: `GET /api/board`** — aggregate from the scan cache (P3), filter by `?project`, `?status`, `?q`.

```typescript
import { NextRequest, NextResponse } from "next/server";
import { scanAllProjects } from "@/lib/scanner";
import { getCachedScan, setCachedScan } from "@/lib/cache";

export async function GET(request: NextRequest) {
  const projectFilter = request.nextUrl.searchParams.get("project");
  const statusFilter = request.nextUrl.searchParams.get("status");
  const q = request.nextUrl.searchParams.get("q")?.toLowerCase();

  let result = getCachedScan();
  if (!result) { result = await scanAllProjects(); setCachedScan(result); }

  const projects = result.projects
    .filter((p) => p.board && (!projectFilter || p.slug === projectFilter))
    .map((p) => ({ slug: p.slug, name: p.name, board: p.board! }));

  // status/q filtering applied per-issue in a helper; return a flat + grouped shape.
  return NextResponse.json({ projects, /* filtered counts */ });
}
```

- [ ] **Step 2: `GET /api/board/[slug]`** — single project's `BoardInfo` from cache (404 if not found), mirroring `insights/[slug]`.

- [ ] **Step 3: `POST /api/board/[slug]`** — mutate. Resolve slug → **canonical** path safely, dispatch on `action`, invalidate the scan cache.

```typescript
export async function POST(request: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const projectPath = await findProjectPathBySlug(slug);   // validates slug → main-tree path
  if (!projectPath) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  const body = await request.json();
  let updated;
  switch (body.action) {
    case "addIssue":   updated = await addIssue(projectPath, body.issue); break;
    case "setStatus":  updated = await setIssueStatus(projectPath, body.id, body.status); break;
    case "move":       updated = await moveIssue(projectPath, body.id, body.toEpicId); break;
    case "reorder":    updated = await reorderIssue(projectPath, body.id, body.order); break;
    case "promoteTodo":updated = await promoteTodoToBoard({ projectPath, ...body }); break;
    default: return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
  invalidateCache();
  return NextResponse.json(updated ?? { epics: [], inbox: [], total: 0 });
}
```

> **Path safety:** use the existing safe resolver (`findProjectPathBySlug`, or `resolveProjectPath(slug, devRoots)` from `tasks/todoDelegation.ts:23` — the traversal-guarded one). The board writer canonicalizes again internally, so worktree paths can't slip through.

- [ ] **Step 4: Verify** — `pnpm typecheck && pnpm test`. Manually: `curl localhost:4100/api/board`, a `POST` round-trip mutating a scratch `BOARD.md`.
- [ ] **Step 5: Commit** — `feat(board): add /api/board GET (cross-project) + per-project GET/POST`

---

### Task C3 (OPTIONAL accelerator): SQLite index + FTS

> **Skip-able.** The board fully works via Tasks C1–C2 (scan cache). Build this only if cross-project search/filter over ~60 repos proves slow, or to land the roadmap's §6.3 schema now. It is gated by `dbModeRequested()` and falls back to the scan-cache path — exactly like `getSkillUsage` (`src/lib/data/index.ts` ~890).

**Files:**
- Modify: `src/lib/db/migrations.ts` (`MIGRATIONS` array ~line 37 — add version **17**)
- Create: `src/lib/data/boardFromDb.ts`
- Modify: `src/lib/db/ingest.ts` (add a `reconcileBoardData(db)` — board source is `BOARD.md`, not JSONL, so it does **not** belong inside `reconcileAllSessions`)
- Modify: `src/lib/data/index.ts` (export a `getBoard()` that gates on `dbModeRequested()` with scan-cache fallback)
- Modify: `src/app/api/board/route.ts` (prefer DB when available)

- [ ] **Step 1: Migration v17** (mirror the `prompts_fts` FTS5 + `WITHOUT ROWID` patterns):

```typescript
{
  version: 17,
  name: "board: epics, issues, fts",
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS board_epics (
        project_slug TEXT NOT NULL,
        id           TEXT NOT NULL,
        title        TEXT NOT NULL,
        status       TEXT,
        priority     TEXT,
        labels_json  TEXT,
        order_index  INTEGER,
        source_path  TEXT,
        line         INTEGER,
        updated_at   INTEGER,
        PRIMARY KEY (project_slug, id)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS board_issues (
        project_slug TEXT NOT NULL,
        id           TEXT NOT NULL,
        epic_id      TEXT,
        title        TEXT NOT NULL,
        status       TEXT,
        priority     TEXT,
        labels_json  TEXT,
        worktree     TEXT,
        session_id   TEXT,
        order_index  INTEGER,
        source_path  TEXT,
        line         INTEGER,
        updated_at   INTEGER,
        PRIMARY KEY (project_slug, id)
      ) WITHOUT ROWID;

      CREATE VIRTUAL TABLE IF NOT EXISTS board_issues_fts USING fts5(
        project_slug UNINDEXED,
        id           UNINDEXED,
        title,
        body,
        tokenize='porter unicode61'
      );
    `);
  },
},
```

- [ ] **Step 2: `reconcileBoardData(db)`** — for each project with a `BOARD.md`, `DELETE` its rows then insert (the per-project delete-then-insert + `db.transaction()` pattern from `ingest.ts` ~2534–2545). Invoke it from `/api/scan` (force-rescan) and lazily from `getBoard()` when the DB is stale — **not** from the pure scanner orchestrator.
- [ ] **Step 3: `boardFromDb.ts`** — `"server-only"`, `prepCached(db, sql)` SELECTs, FTS join for `?q`. Return the same shape the API already emits so callers are backend-agnostic.
- [ ] **Step 4: `getBoard()` in `data/index.ts`** — `if (!dbModeRequested()) return <scan-cache path>; const db = await getReadyDb(); … cold-index fallback to scan cache if zero rows`.
- [ ] **Step 5: Verify** — `pnpm typecheck && pnpm test`; test with `MINDER_USE_DB=0` (scan-cache) and unset (DB) — identical results.
- [ ] **Step 6: Commit** — `feat(board): optional SQLite index + FTS with scan-cache fallback`

---

# Group D — UI + docs (PR 4)

### Task D1: Cross-project Board page

**Files:**
- Create: `src/components/BoardBrowser.tsx`
- Create: `src/app/board/page.tsx`
- Reference: `src/app/agents/page.tsx` (current page convention — `useDocumentTitle` + `shell-content wide`), `src/components/InsightsBrowser.tsx`.

- [ ] **Step 1: `src/app/board/page.tsx`** (current convention):

```typescript
"use client";
import { BoardBrowser } from "@/components/BoardBrowser";
import { useDocumentTitle } from "@/hooks/useDocumentTitle";

export default function Page() {
  useDocumentTitle("Board");
  return (
    <div className="shell-content wide">
      <BoardBrowser />
    </div>
  );
}
```

- [ ] **Step 2: `BoardBrowser.tsx`** — fetch `/api/board`, render columns by `BoardStatus` (NOC-dense per `PRODUCT.md`: data panels, muted amber status, condensed labels). Controls: search (`?q`, debounced like `InsightsBrowser`), project filter, status filter. Group issues under epics; render the Inbox as its own lane. Each issue links to its project (`/project/<slug>`); `@wt:`/`~session:` provenance shown as small chips.
- [ ] **Step 3: Verify** — `pnpm typecheck && pnpm test`; load `localhost:4100/board`.
- [ ] **Step 4: Commit** — `feat(board): add cross-project Board page`

---

### Task D2: Per-project Board tab

**Files:**
- Create: `src/components/BoardTab.tsx`
- Modify: `src/components/ProjectDetail.tsx` (`TabKey` union ~line 54; `hasBoard` condition ~line 162; conditional `tabs` array ~lines 164–184; content renderer block ~lines 355–579)

> The current `ProjectDetail` uses a **custom button tab bar** with an `activeTab` switch (not Radix `Tabs`). Mirror the live pattern, not the older insights plan.

- [ ] **Step 1:** Add `"board"` to `TabKey`; `const hasBoard = !!(project.board && project.board.total > 0);`; insert `...(hasBoard ? [{ key: "board" as TabKey, label: \`Board${project.board ? \` (${project.board.total})\` : ""}\` }] : []),` after the insights entry.
- [ ] **Step 2:** Add the renderer: `{activeTab === "board" && <BoardTab slug={project.slug} board={project.board} />}`.
- [ ] **Step 3: `BoardTab.tsx`** — render the project's epics/issues/inbox; wire `setStatus`/`addIssue` to `POST /api/board/[slug]` with optimistic refresh.
- [ ] **Step 4: Verify + Commit** — `feat(board): add per-project Board tab`

---

### Task D3: Card badge

**Files:**
- Create: `src/components/BoardCompact.tsx`
- Modify: `src/components/ProjectCard.tsx` (badge row — **confirm the current convention first**: the scout found `InsightsCompact`/`ManualStepsCompact` may not currently render on the card. Match whatever badges *do* render, e.g. `GitStatusCompact`/`ClaudeSessionCompact`.)

- [ ] **Step 1: `BoardCompact.tsx`** — mirror the **inline-style** convention of `InsightsCompact.tsx` (CSS vars, not Tailwind classes):

```typescript
import { BoardInfo } from "@/lib/types";
import { LayoutGrid } from "lucide-react";

export function BoardCompact({ board }: { board: BoardInfo }) {
  if (board.total === 0) return null;
  const open = board.epics.flatMap((e) => e.issues).concat(board.inbox)
    .filter((i) => i.status !== "done").length;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
      <LayoutGrid style={{ width: "11px", height: "11px", color: "var(--text-muted)" }} />
      <span style={{ fontSize: "0.72rem", color: "var(--text-muted)" }}>{open} open</span>
    </div>
  );
}
```

- [ ] **Step 2:** Render `{project.board && <BoardCompact board={project.board} />}` in the card's badge row.
- [ ] **Step 3: Verify + Commit** — `feat(board): add BoardCompact card badge`

---

### Task D4: Nav + help docs + help-mapping

**Files:**
- Modify: nav (find how `/insights` or `/agents` is linked — the scout reported nav is **not** a confirmed 3-dropdown `AppNav`; add the `/board` link adjacent to its siblings wherever they live)
- Modify: `src/lib/help-mapping.ts` (`helpMapping` ~5–45; `tabHelpMapping` ~51–69; `helpSlugs` ~72+)
- Create: `docs/help/board.md`
- Create: `public/help/board.md` (runtime-fetchable copy)

- [ ] **Step 1:** Add a **Board** nav entry next to Insights/Agents (match the existing mechanism, don't invent one).
- [ ] **Step 2:** `helpMapping['/board'] = 'board'`; `tabHelpMapping.board = 'board'`; add `'board'` to `helpSlugs`.
- [ ] **Step 3:** Write `docs/help/board.md` — explain `BOARD.md` grammar (epic/issue/inbox, status glyphs, `!priority`, `#labels`, `^e-/^i-` stable IDs, `@wt:`/`~session:` provenance), the TODO→board promote path, the `BOARD.archive.md` done lane, and that planning is canonical to the main tree. `cp docs/help/board.md public/help/board.md`.
- [ ] **Step 4: Verify + Commit** — `docs(board): add Board help doc + route mapping + nav link`

---

# Group E — Docs + final verification

### Task E1: CHANGELOG + CLAUDE.md architecture

**Files:** `CHANGELOG.md`, `C:\dev\project-minder\CLAUDE.md`

- [ ] **Step 1: CHANGELOG `[Unreleased] > Added`**

```markdown
- **Board** — a git-tracked `BOARD.md` per project (epics → issues, with stable IDs, status, priority, labels, and worktree/session provenance). Cross-project `/board` view, per-project Board tab, and card badge. Create/move/reorder/promote via `POST /api/board/[slug]`. TODO→board promote path. `BOARD.archive.md` companion for the done lane. Gated by the `scanBoard` flag. Optional SQLite index (`board_*` tables + FTS) accelerates cross-project search when `MINDER_USE_DB` is on.
```

- [ ] **Step 2: CLAUDE.md** — under Architecture › Scanner, bump the module list to include `boardMd`; under API Routes add the `/api/board` lines; under UI add the `BoardBrowser` / `ProjectBoardTab` / `BoardCompact` line; note the canonicalization rule under Conventions.
- [ ] **Step 3: Commit** — `docs: update CHANGELOG + CLAUDE.md for canonicalization + Board`

### Task E2: Final verification gate

- [ ] **Step 1:** `pnpm typecheck` — clean.
- [ ] **Step 2:** `pnpm test` — full suite green; **report exact pass count** (per CLAUDE.md Verification Gates).
- [ ] **Step 3: Manual browser pass** — `/board` loads and filters; a project detail page shows the **Board** tab; a `POST` mutation reflects on next scan; worktree write redirects to the canonical file (create a scratch worktree, append a TODO, confirm it lands in the parent project's file and the worktree copy is untouched).
- [ ] **Step 4:** If green, open PRs per the boundaries above (feature branch → PR; never push to `main`).

---

## Open items deferred to later phases (not Phase 1)

- **MCP write-bridge** (`board_create_issue`, `board_log_finding`, `board_postpone`, `board_promote_to_task`) — **Phase 2**. The `## Inbox` section and `@wt:`/`~session:` provenance built here are its landing zone; `promoteTodoToBoard` foreshadows `board_promote_to_task`.
- **Board issue → executable task** (bridge into `~/.minder/tasks.db` via the dispatcher, reusing `delegateTodo`) — stub the promote action now, wire the task bridge with the MCP work in Phase 2.
- **Portfolio-level epics** (one epic spanning repos) — per-repo first (roadmap §9 lean); revisit if needed.
- **Drag-to-reorder UX polish** — `reorderIssue` exists as an API; rich DnD is a follow-up.
