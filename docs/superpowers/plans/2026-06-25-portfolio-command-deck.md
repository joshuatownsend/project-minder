# Portfolio Command Deck — Roadmap & Architecture Plan

> **Altitude note:** This is a *roadmap/architecture* plan, not a task-by-task implementation plan.
> It captures the vision, the locked design decisions, the board data model, and a phased breakdown
> grounded in the existing codebase. When we start building a phase, generate a detailed task-by-task
> implementation plan for **that phase** in the usual house style (see
> `docs/superpowers/plans/2026-04-10-insights.md`), and a companion design spec under
> `docs/superpowers/specs/` if the phase warrants it.

**Status:** Proposed (2026-06-25). Decisions locked with the operator; not yet scheduled for build.

---

## 1. Goal / Vision

Today Project Minder is excellent at *minding what happens **inside** Claude Code* — sessions, usage,
agents, skills, telemetry. It is weak at *minding the **projects themselves** from a high level*: the
epics, statuses, and operational facts you'd otherwise track in Jira/Linear plus a runbook plus the
GitHub UI.

**Make Minder the single pane of glass for the portfolio.** For each of ~60 local projects, one place to
see and act on:

1. **High-level project management** — epics → issues → status, interactive, cross-project. ("Mind my projects.")
2. **Agent ⇄ board round-trip** — a running Claude Code session can push a new todo, log a finding, or
   postpone a task *directly into Minder* via MCP, without leaving the terminal.
3. **Operational dashboard** — per project: where it deploys (Vercel/Railway/Fly/…), what services it uses
   (Supabase/Neon/Clerk/Stripe/…), and how it's kept healthy (backups, monitoring, on-call).
4. **GitHub activity in-pane** — open PRs, recent pushes, CI status — so you stop bouncing between the
   GitHub UI, a PM tool, and the terminal.

The unifying north star (and the visual identity from `PRODUCT.md`): a **NOC wallboard / glass-cockpit** for
your whole portfolio — dense, operational, every pixel a signal.

---

## 2. What we borrowed (research synthesis)

Three external tools informed this. None are code we can lift (two are Electron desktop apps; Plane is a
heavyweight Django/Postgres/Redis stack). Their value is **data models and concepts**:

| Source | What it is | What we take |
|---|---|---|
| **Nimbalyst** (951★, Electron; ex-"Crystal") | Visual workspace for Codex/Claude Code; WYSIWYG markdown, session kanban, task tracking | **"Open storage of content and status in markdown… plain files on disk or in git."** Tasks are markdown that *both* the agent and human edit. Categories: plans / bugs / features / todos. |
| **Cyboflow** (fork of Crystal 0.3.5, Electron) | Multi-agent workflow runner for Claude Code | (a) **Findings** — agents surface discoveries mid-work that get triaged into future tasks (this *is* the "push a todo via Claude Code" idea); (b) an **outbound MCP bridge** (agent→app writes); (c) **epics → tasks** with a lifecycle; (d) a **review queue** categorizing agent asks as Permission / Decision / Action, blocking vs non-blocking. |
| **Plane** (53k★, Django + React; Jira/Linear/Monday alternative) | Full open-source PM platform | The **vocabulary** — Work Items, Cycles (sprints), **Modules (= epics)**, Views (saved filters), Pages (docs), Analytics — and the specific thing the operator called out: a **GitHub activity surface** (PRs, pushes, CI) inside the PM tool. |

---

## 3. What Minder already has (the substrate we build on)

Crucially, ~70% of the plumbing exists. This plan is mostly **composition + a high-level layer**, not greenfield.

- **Planning files, parsed + write-capable:**
  - `TODO.md` → `src/lib/scanner/todoMd.ts` → `TodoInfo`/`TodoItem` (`src/lib/types.ts:434`); writer `toggleTodoInFile()` in `src/lib/todoWriter.ts`.
  - `MANUAL_STEPS.md` → scanner + `src/lib/manualStepsWatcher.ts` (fs.watch, 500ms debounce, 60s poll) + `src/lib/manualStepsWriter.ts`.
  - `INSIGHTS.md` → `src/lib/scanner/insightsMd.ts` + `src/lib/insightsWriter.ts` (append-only, dedup by hash).
- **A real task *execution* engine already exists** (this is the big one):
  - Task model `src/lib/tasks/types.ts:94-123`; statuses `pending|awaiting_approval|running|done|failed|cancelled`; quadrants `do|schedule|delegate|archive|delegated-todo`; `LEGAL_TRANSITIONS` (`types.ts:85-92`).
  - Persisted in a **separate SQLite DB** `~/.minder/tasks.db` (`src/lib/tasksDb/connection.ts`, `src/lib/tasks/store.ts`).
  - Background **dispatcher** singleton `src/lib/tasks/dispatcher.ts` (30s tick, `MAX_CONCURRENT=3`, emergency-stop gate, heartbeat file) that **spawns Claude Code** via `src/lib/tasks/spawner.ts` (`runClassicTask` / `runStreamTask` / `runWorktreeTask`).
  - `delegateTodo()` (`src/lib/tasks/todoDelegation.ts:41`) already turns a `TODO.md` line into a dispatched task; `onTaskCompleteToggleTodo()` checks the box back on completion. ← the promote-to-task bridge we need *already exists in miniature.*
  - **Swarms** (`Swarm` `types.ts:1-14`, `/swarms`) — multi-agent worktree orchestration.
  - **gsdPlanning** (`GsdPlanningInfo` `types.ts:98-107`, `/plans`) — multi-phase plan tracking read from `.planning/` (a higher-level planning notion already exists).
- **Operational detection already exists:**
  - `src/lib/scanner/cicd.ts` (480 lines) → `CiCdInfo` (`types.ts:1126-1131`) = `{ workflows, hosting, vercelCrons, dependabot }`. Detects **Vercel** (framework/buildCommand/crons), **Railway** (app/regions), **Fly** (app/region), **Render**, **Netlify**, **Heroku**, **Docker**, **GitHub Actions**, **Dependabot** — each `HostingTarget` carries `{ platform, sourcePath, detail{} }`.
  - `src/lib/scanner/envFile.ts:62` → detects 24 service types by key patterns (Supabase, Clerk, Stripe, AWS, OpenAI, Anthropic, …) → `externalServices: string[]`; `DATABASE_URL` → `DatabaseInfo { type, host, port, name }`.
  - `src/lib/scanner/dockerCompose.ts:11` → services + port mappings.
- **MCP server**, direct-lib-call pattern: `src/lib/mcp/server.ts` → `createMcpServer()` → `registerXxxTools(server)` per domain. Today only the manual-steps toggle is a *write* tool; everything else is read-only. Adding a write tool is a known pattern.
- **Worktree overlay**: `src/lib/scanner/worktrees.ts` discovers `--claude-worktrees-` dirs, resolves each back to its **parent project**, and already reads TODO/MANUAL_STEPS/INSIGHTS from them. (We will change *how* this is presented — see §5.)
- **Background cache pattern** to copy: `src/lib/gitStatusCache.ts` (globalThis singleton, batches of 3, 5-min TTL, polled by the client). The GitHub-activity cache mirrors this.
- **GitHub today = text-extraction only**: `src/lib/usage/prExtractor.ts:207` (`gh pr create` → `PrLink[]`), `src/lib/usage/ticketExtractor.ts:178` (Linear/Jira/GitHub-issue URLs → `TicketLink[]`). **No live `gh`/API calls** — confirming the GitHub-activity pillar is net-new.
- **Conventions**: pages are `"use client"` `src/app/<route>/page.tsx` → `useDocumentTitle()` → `<Browser/>` in a `shell-content wide` wrapper; API routes `src/app/api/<name>/route.ts`; nav via `AppNav` (3-dropdown) + `lib/help-mapping.ts`; feature flags `FeatureFlagKey` (`types.ts:512`, `src/lib/featureFlags.ts`) gate scanners (return `undefined`/neutral when off); config `MinderConfig` (`types.ts:579-660`) in `.minder.json`.

---

## 4. Locked decisions (with rationale + future triggers)

### D1 — Board storage: **markdown-in-repo, indexed to SQLite** (Option A)
The authored backlog lives as a git-tracked markdown file **in each project's repo**; a SQLite **index**
(the existing `~/.minder/index.db`, which is explicitly a *derived, rebuildable index*) powers the fast
cross-project board.

**Why:** durability (your planning survives a DB wipe — index corruption, which Minder has hit before with
FTS5, only costs a rebuildable index, never the backlog); portability (the board travels with each repo and
is backed up by the `git push` you already do); agent writes are trivial and *reviewable as diffs* (agents
already edit `TODO.md`/`MANUAL_STEPS.md`); and it matches both Minder's "filesystem = source of truth"
philosophy and Nimbalyst's "open storage in plain files." The cost we accept eyes-open: building a tolerant
markdown board grammar + parser/writer with stable IDs and ordering (§6).

**Future trigger → Option B (server-owned store):** when Minder is deployed as a service (local Docker,
Vercel, multi-client), migrate the authored board from per-repo markdown into a server store. A→B is a
one-time parse-and-seed; starting at A keeps that door open.

### D2 — Planning is **project-scoped, canonical to the main tree** (the worktree fix)
Git worktrees each get their own checkout, so a tracked `TODO.md` becomes **N divergent copies**, visible
only after merge. That's correct for *code* (branch-scoped) but wrong for *planning* (project-scoped). Fix:
planning files have **one canonical home in the main working tree**, and **every writer** — UI, watcher, the
new MCP tool — resolves to that path, never the worktree's `cwd`. The worktree→parent resolution already
exists in `src/lib/scanner/worktrees.ts`.

**Why it also fixes merge noise:** if a worktree agent appends to *main's* file (not its own copy), Minder
shows it instantly *and* the worktree's copy is never touched — so relative to the merge-base there's nothing
to conflict. Main's planning advances freely; the branch's stale copy quietly defers.

Refinements: items carry **provenance tags** (`@wt:<branch>`, `~session:<id>`) so you see where a todo came
from without fragmenting storage; agent writes are **append-only**, structural edits (reorder/move) go
through Minder as the single serializing writer.

### D3 — GitHub data source: **`gh` CLI, background-cached**
Minder runs as an always-on local server, so the connected GitHub **MCP** is out (session-scoped,
unreachable at runtime). `gh` is already authenticated, matches the project's "use gh for GitHub ops"
convention, and mirrors `gitStatusCache`. **Future trigger → Octokit + PAT/GraphQL** if/when rate limits
bite or we want one batched call across many repos.

### D4 — Sequence: **board-first**
The worktree fix (D2) and the board share the same files and canonical-path plumbing, and the board is the
core ask — so they ship together first. The MCP bridge is small but pointless until the board exists to
receive items, so it follows. Ops and GitHub are the most independent surfaces and come next.

---

## 5. Core principle baked in everywhere: planning ⟂ branch

```
            CODE                         PLANNING
   ───────────────────────      ──────────────────────────
   branch-scoped                project-scoped
   lives in each worktree       one canonical copy (main tree)
   merges back                  writers resolve to canonical path
   worktree overlay shows       board/TODO/manual-steps UNIFIED,
   branch/dirty/ahead-behind    worktree activity FEEDS into it
```

Concretely, the existing worktree overlay (`src/lib/scanner/worktrees.ts`) stops presenting per-worktree
*planning* copies as separate panels. It keeps presenting per-worktree **code** status. Planning is read
from, and written to, the canonical main-tree file — with worktree-originated items tagged for provenance.

---

## 6. The board data model (the pivotal design artifact)

### 6.1 Storage: `BOARD.md` at repo root (git-tracked, canonical to main tree)
A new file, distinct from `TODO.md`. `TODO.md` remains the lightweight quick-capture inbox; the board is the
structured epic/issue layer. The board can **promote** a `TODO.md` line into a board issue (reusing the
`delegateTodo()` pattern), and a board issue can **promote to an executable task** in `~/.minder/tasks.db`
via the existing dispatcher — so "run this with Claude Code now" is one click without the board itself living
in a DB.

### 6.2 Grammar (markdown, human- and agent-editable, tolerant of hand edits)

```markdown
# Board — crew-leader

<!-- minder-board: v1 -->

## Epic: Authentication overhaul ^e-a1b2  [in-progress]  !high  @clerk
> Move off NextAuth to Clerk; ship before billing.

- [ ] Wire Clerk provider ^i-3c4d  [todo]  !high  #auth  @wt:auth-refactor
  Acceptance: middleware protects /api/*, session persists across reload.
- [>] Protect /api routes ^i-5e6f  [doing]  #auth
- [x] Spike: Clerk vs WorkOS ^i-7a8b  [done]  #research

## Epic: Billing ^e-c3d4  [backlog]
- [ ] Stripe webhooks ^i-9f0a  [todo]  !med  #billing

## Inbox
<!-- agent-pushed findings/todos land here for triage -->
- [ ] (finding) Rate limiter is O(n²) under load ^i-b1c2  [triage]  @wt:auth-refactor  ~session:abcd1234
```

Token grammar:
- **Epic header** — `## Epic: <title> ^e-<id>  [<status>]  !<priority>  @<tag>…` + optional `>` blockquote description.
- **Issue line** — `- [<glyph>] <title> ^i-<id>  [<status>]  !<priority>  #<label>…  @wt:<branch>  ~session:<id>` + indented detail lines.
- **Stable IDs** — `^e-xxxx` / `^i-xxxx` (short, Obsidian-style block refs). The indexer keys on these so reorder/edit tracks the same item. Minder **backfills** an ID when a human adds a bare `- [ ] thing` (so hand-capture stays frictionless).
- **Status** — `backlog | todo | doing | review | done | triage`. Mirrored in the checkbox glyph (`[ ]`/`[>]`/`[x]`) for readability and compatibility with the existing checkbox toggler.
- **Priority** — `!high | !med | !low`.
- **Labels** — `#auth`, `#billing`, …
- **Provenance** — `@wt:<branch>` (origin worktree), `~session:<id>` (origin Claude session).
- **Ordering** — file line order = column order; reorder = Minder rewrites order (serializing writer).
- **Inbox section** — where the MCP bridge drops findings/todos/postpones for triage.

### 6.3 Index schema (derived, in `~/.minder/index.db` — rebuildable from `BOARD.md`)
```
board_epics(project_slug, id, title, status, priority, labels_json, order_index, source_path, line, updated_at)
board_issues(project_slug, id, epic_id, title, status, priority, labels_json,
             worktree, session_id, order_index, source_path, line, updated_at)
board_issues_fts(title, body)   -- FTS5 for cross-project search
```
Backend selection follows the existing `MINDER_USE_DB` switch; with the DB off, the cross-project board falls
back to parsing `BOARD.md` per project (cache-mitigated, like other scanners).

### 6.4 Types (new, `src/lib/types.ts`)
```typescript
export type BoardStatus = "backlog" | "todo" | "doing" | "review" | "done" | "triage";
export type BoardPriority = "high" | "med" | "low";

export interface BoardIssue {
  id: string; title: string; status: BoardStatus; priority?: BoardPriority;
  labels: string[]; epicId?: string;
  worktree?: string; sessionId?: string;   // provenance
  detail?: string; line: number; order: number;
}
export interface BoardEpic {
  id: string; title: string; status: BoardStatus; priority?: BoardPriority;
  labels: string[]; description?: string; line: number; order: number;
  issues: BoardIssue[];
}
export interface BoardInfo { epics: BoardEpic[]; inbox: BoardIssue[]; total: number; }
```
Add `board?: BoardInfo` to `ProjectData` (`src/lib/types.ts:23-96`).

---

## 7. Phased roadmap

> Each phase is gated by its own `FeatureFlagKey`, ships behind `pnpm typecheck` + full test suite (per the
> repo's Verification Gates), and updates `docs/help/` + `CHANGELOG.md` per the Documentation/Changelog policy.

### Phase 1 — Planning canonicalization + Board MVP  *(board-first; fixes the worktree pain)*
**Outcome:** one project-scoped planning truth, live across worktrees, plus a working epic/issue board
(per-project tab + cross-project view).

- **1a. Canonicalization layer**
  - Add a `resolveCanonicalProjectPath(cwd)` helper (reuse worktree→parent logic from `src/lib/scanner/worktrees.ts`).
  - Route `todoWriter`, `manualStepsWriter`, `insightsWriter`, and the watcher through it.
  - Change `worktrees.ts` overlay: stop surfacing per-worktree *planning* copies as separate panels; keep *code* status. Tag worktree-originated items with `@wt:<branch>`.
  - Update `CLAUDE.md`'s Manual-Step-logging block so agents log to the **canonical project file**, not `cwd`.
- **1b. Board parser/writer** — `src/lib/scanner/boardMd.ts` (`scanBoardMd`, `parseBoardMd`) + `src/lib/boardWriter.ts` (add/move/reorder/edit/promote; ID backfill; append-safe). Tests in `tests/boardMd.test.ts` (the testing convention — pure parser/writer logic).
- **1c. Index + scanner integration** — add board tables/migrations under `src/lib/db/`; ingest in the scanner orchestrator (`src/lib/scanner/index.ts`); `boardFromDb.ts` query module via `probeInitStatus()`.
- **1d. API** — `GET /api/board` (cross-project, `?project`, `?status`, `?q`), `GET /api/board/[slug]`, `POST /api/board/[slug]` (create/move/reorder/promote).
- **1e. UI** — `src/app/board/page.tsx` + `BoardBrowser` (cross-project, columns/views, NOC-dense per `PRODUCT.md`); `ProjectBoardTab` on the detail page; `BoardCompact` badge on cards; nav + `help-mapping` wiring; `docs/help/board.md` (+ `public/help/`).
- **Flag:** `scanBoard`. **Risk:** parser robustness + reorder concurrency — mitigate with append-only agent writes and Minder-as-serializer.

### Phase 2 — MCP write-bridge (agent → board)
**Outcome:** a running Claude Code session pushes items into Minder without leaving the terminal.

- New write tools on the MCP server (`src/lib/mcp/tools/board.ts`, registered in `src/lib/mcp/server.ts`):
  `board_create_issue`, `board_log_finding`, `board_postpone` (move to `backlog`/snooze), `board_promote_to_task`.
- All resolve to the **canonical** `BOARD.md` (D2) and tag provenance (`~session:<id>`, `@wt:<branch>`).
  Findings/todos land in `## Inbox` for triage; `board_promote_to_task` bridges into `~/.minder/tasks.db` via the existing dispatcher.
- Update `docs/help/mcp-server.md` with the new surface; keep DNS-rebinding pin to `localhost:4100`.
- **Borrowed shape:** Cyboflow's Findings + outbound bridge; the review-queue categories (Permission/Decision/Action) inform how Inbox items are typed.

### Phase 3 — Per-project Operations panel
**Outcome:** one operational view per project; ~70% auto-detected, the rest curated.

- **3a. Compose existing detection** into an `OpsSummary` (deploy targets from `CiCdInfo.hosting`, services from `externalServices`, db from `DatabaseInfo`, crons from `vercelCrons`, Dependabot). No new scanning — a derive-and-present layer (`src/lib/ops/summary.ts`).
- **3b. `OPERATIONS.md` runbook** — a new canonical planning file (same §5 rules) for the human-curated facts that can't be auto-detected: **backups** (where/how/retention), **monitoring/alerting**, **on-call/escalation**, **secrets/rotation**, **restore procedure**. Parser `src/lib/scanner/operationsMd.ts`; structured sections.
- **3c. Extend service detection** where cheap (Neon host on `DATABASE_URL`, Firebase, PlanetScale, Upstash) in `envFile.ts`.
- **UI** — `OpsPanel` on the project detail page; `docs/help/operations.md`. **Flag:** `scanOps`.

### Phase 4 — GitHub activity surface
**Outcome:** open PRs, recent pushes, CI status per project, in-pane (the Plane win).

- `src/lib/githubActivityCache.ts` — globalThis singleton mirroring `gitStatusCache` (background batches, 5-min TTL); shells to `gh` (`gh pr list --json`, `gh run list --json`, `gh api` for recent commits/pushes). Resolve repo from git remote.
- `GET /api/github-activity` (polled by client, like `/api/git-status`).
- **UI** — a GitHub strip on the project card + detail (PR count, checks pass/fail, last push relative time); reuse the existing `PrLink`/`TicketLink` extraction to cross-link sessions↔PRs. `docs/help/github-activity.md`. **Flag:** `githubActivity`.

### Phase 5 — Later / opt-in (documented triggers, not v1)
- **Live ops status** — pull live deploy state / uptime / metrics from platform APIs or the connected
  Vercel/Railway/Supabase MCPs (when a session is driving). Upgrades Phase 3 from static to live.
- **Octokit + PAT/GraphQL** — the D3 scale-up.
- **B-storage migration** — the D1 trigger when Minder becomes a hosted service.
- **Cycles/sprints & saved Views** — Plane's time-boxing and saved cross-project filters, if solo-dev cadence ever wants them.

---

## 8. Cross-cutting concerns
- **Concurrency / races** — agent writes append-only; structural edits serialized through Minder; reuse the
  manual-steps debounce/line-number approach; the canonical-path rule (D2) removes the worst race (worktree vs main divergence).
- **Feature flags** — every new scanner/cache gated (`scanBoard`, `scanOps`, `githubActivity`), default-on,
  neutral when off, per the existing `featureFlags.ts` pattern.
- **Testing** — pure parser/writer logic gets `tests/*.test.ts` (board grammar round-trip is the highest-value
  test: parse→write→parse must be stable and preserve hand formatting). UI/API validated via `pnpm build` + manual browser testing.
- **Docs/Changelog** — `docs/help/*` + `public/help/*` + `lib/help-mapping.ts` for each new route; `CHANGELOG.md`
  `[Unreleased]` entries (UI/API/MCP behavior changes qualify).
- **Visual identity** — `PRODUCT.md`: dense, operational, muted amber for status, condensed grotesque labels;
  cards are data panels, not tiles.

## 9. Open questions to resolve at build time
- **`BOARD.md` vs enriching `TODO.md`** — proposed: separate `BOARD.md` (structured) + `TODO.md` (inbox) with a
  promote path. Confirm before Phase 1b.
- **Epic granularity** — is a per-repo board enough, or do we want **portfolio-level epics** spanning repos
  (an epic with issues in 3 projects)? Affects whether epics also get a global store. (Lean: per-repo first; add cross-repo epic links later.)
- **Inbox triage UX** — auto-file findings into an epic by label, or always land in `## Inbox` for manual triage? (Lean: Inbox-first, with one-click "move to epic.")
- **`gh` rate limits** across ~60 repos on each refresh — may force the Phase-4→Octokit/GraphQL trigger sooner.

## 10. Appendix — references
- Inspiration repos: `github.com/Nimbalyst/nimbalyst`, `github.com/kesteva/cyboflow`, `github.com/makeplane/plane`.
- Operator design context: `PRODUCT.md`, `docs/brainstorming/build-your-own-dashboard-prompt.md`.
- Existing related surfaces to reconcile with: `/tasks`, `/swarms`, `/plans` (gsdPlanning), `/manual-steps`, `/insights`, and the help docs `docs/help/{tasks,kanban,gsd-planning,plans}.md`.
- **Living-checklist + archive convention (shipped 2026-06-26):** `TODO.md`/`MANUAL_STEPS.md` are now living checklists — completed/obsolete items are pruned into companion `*.archive.md` files (scanners ignore them), and `manualStepsWatcher` diffs new entries by identity rather than array position. **Phase 1's board `done`/history lane should read these `*.archive.md` files as its source** rather than inventing a separate archive. The canonicalization principle (D2) applies to the archive files too. Source: `src/lib/setup-content.ts`, `src/lib/manualStepsWatcher.ts`, `CLAUDE.md`.
