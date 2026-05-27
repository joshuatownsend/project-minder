# CLAUDE.md

Project: **Project Minder** — local-only dashboard that auto-scans `C:\dev\*` projects and surfaces metadata for fast context-switching.

## Stack

- **Next.js 16** (App Router) + TypeScript + React 19
- **Tailwind CSS v4** + hand-rolled shadcn-style components (no shadcn CLI)
- **No database** — filesystem is the database; user prefs in `.minder.json`
- **Dev port: 4100** — Turbopack is the default bundler in Next.js 16

## Commands

This project uses **pnpm** (pinned via the `packageManager` field; CI runs `pnpm install --frozen-lockfile`). `pnpm-lock.yaml` is the source of truth — there is no `package-lock.json`.

- `pnpm dev` — starts on port 4100 (Turbopack is default in Next.js 16)
- `pnpm build` — production build
- `pnpm start` — production server on port 4100
- `pnpm typecheck` — fast standalone type-check via tsgo (TypeScript 7 Go port, ~10× faster than tsc)
- `pnpm test` — run all tests (vitest)
- `pnpm test:watch` — run tests in watch mode

## Testing

- **Framework:** Vitest with `@/*` path alias support (config in `vitest.config.ts`)
- **Test location:** `tests/*.test.ts` — flat directory, one file per module
- **Pattern:** Mock `fs` at module level with `vi.mock("fs")`, test pure parsing/transformation logic
- **Coverage:** Scanner modules (`todoMd`, `manualStepsMd`, `insightsMd`, `worktrees`), `insightsWriter`, and usage modules (`classifier`, `shellParser`, `mcpParser`, `oneShotDetector`, `costCalculator`)
- **Pre-commit hook:** Local setup only (not version-controlled) — `.git/hooks/pre-commit` runs `pnpm typecheck && pnpm test -- --pool=forks` before each commit. New clones must set this up manually (`pnpm setup-hooks`).
- **When to write tests:** When adding or modifying scanner modules, parsers, or any pure logic function in `src/lib/`. UI components and API routes are validated through `pnpm build` + manual browser testing.
- **When to run tests:** Always run `pnpm test` before committing. The pre-commit hook enforces this, but run manually first to catch failures early.

## Architecture

### Scanner (`src/lib/scanner/`)
- `index.ts` — orchestrator: reads `C:\dev\*` dirs, runs scanner modules in parallel (batches of 10), detects port conflicts
- 9 scanner modules: `packageJson`, `envFile`, `dockerCompose`, `git`, `claudeMd`, `todoMd`, `claudeSessions`, `manualStepsMd`, `insightsMd`
- Claude history: reads `~/.claude/history.jsonl` using **full Windows paths** (e.g., `C:\dev\my-app`), parsed once and cached in a Map
- In-memory scan cache with 5-min TTL (`src/lib/cache.ts`)
- User config in `.minder.json`: project statuses, hidden list, port overrides, `devRoot` (`src/lib/config.ts`)

### Process Manager (`src/lib/processManager.ts`)
- Singleton that tracks spawned dev server child processes
- Calls project binaries directly (`node_modules/.bin/next.cmd`) with explicit `--port` to avoid inheriting Turbopack IPC state from our server process
- Uses minimal env (only Windows system vars) to prevent Next.js env leaking
- Stores last 200 lines of stdout/stderr per process
- `detached: true` for clean process tree management; `taskkill /F /T` for stop

### Git Status Cache (`src/lib/gitStatusCache.ts`)
- `globalThis` singleton that runs `git status --porcelain` in background batches of 3
- Enqueued by `/api/projects` on each dashboard load; results polled by client via `/api/git-status`
- 5-min TTL matching scan cache; detail page on-demand checks also update this cache
- Dashboard cards show amber `+N` indicators as results arrive

### Manual Steps Watcher (`src/lib/manualStepsWatcher.ts`)
- `globalThis` singleton that watches `MANUAL_STEPS.md` files across all projects
- `fs.watch` per file with 500ms debounce (Windows fires duplicate events)
- Polls every 60s for new `MANUAL_STEPS.md` files (created by Claude mid-session)
- Detects new entries vs. checkbox toggles by comparing `## ` header count
- Exposes `getChanges(since)` for notification polling (in-memory, no FS I/O)
- Writer (`src/lib/manualStepsWriter.ts`): toggles `- [ ]` ↔ `- [x]` by line number

### Worktree Overlay (`src/lib/scanner/worktrees.ts`)
- Discovers Claude Code worktree directories in devRoot by `--claude-worktrees-` naming convention
- Reads TODO.md, MANUAL_STEPS.md, INSIGHTS.md from each worktree directory
- Attaches `WorktreeOverlay[]` to parent project's `ProjectData` — purely read-only
- Branch name resolved from worktree `.git` file's `gitdir:` → `HEAD` ref, with directory-name fallback
- ManualStepsWatcher extended to also watch worktree MANUAL_STEPS.md files (composite slug `parentslug:worktree:branchhint`)

### Usage Module (`src/lib/usage/`)
- `types.ts` — UsageTurn, UsageReport, CategoryType, ModelCost, ShellStats, McpServerStats, OneShotStats
- `parser.ts` — reads `~/.claude/projects/` JSONL files into `UsageTurn[]` with 2-min globalThis cache
- `classifier.ts` — 13-category deterministic classification (Git Ops, Build/Deploy, Testing, Debugging, Refactoring, Delegation, Planning, Brainstorming, Exploration, Feature Dev, Coding, Conversation, General)
- `shellParser.ts` — extracts binary names from Bash/PowerShell commands, groups by frequency
- `mcpParser.ts` — identifies `mcp__server__tool` convention, groups by server
- `oneShotDetector.ts` — detects Edit→Bash(test)→re-edit retry cycles, computes success rate
- `costCalculator.ts` — LiteLLM pricing (24h file cache) with hardcoded Claude fallbacks
- `aggregator.ts` — orchestrates all modules, filters by period/project, produces UsageReport

### API Routes (`src/app/api/`)
- `GET /api/projects` — all scanned projects (uses cache)
- `GET /api/projects/[slug]` — single project
- `POST /api/scan` — force rescan (invalidates cache)
- `GET/PUT /api/config` — read/update statuses and hidden list
- `GET /api/dev-server` — list all managed dev servers
- `GET /api/dev-server/[slug]` — status + output for one server
- `POST /api/dev-server/[slug]` — `{action: "start"|"stop"|"restart", projectPath}`
- `GET /api/manual-steps` — all projects with manual steps (`?pending=true` to filter)
- `GET /api/manual-steps/[slug]` — manual steps for one project
- `POST /api/manual-steps/[slug]` — toggle checkbox `{lineNumber}`
- `GET /api/manual-steps/changes?since=ISO8601` — new-entry change events for notifications
- `GET /api/insights` — all insights cross-project (`?project=slug`, `?q=searchterm`)
- `GET /api/insights/[slug]` — insights for one project
- `GET /api/git-status` — background git dirty status cache (polled by dashboard)
- `GET /api/stats` — aggregated portfolio stats + Claude Code usage analytics
- `GET /api/usage` — token usage report (`?period=today|week|month|all`, `?project=slug`)
- `GET /api/usage/export` — CSV/JSON export (`?format=csv|json`, same period/project params)
- `GET /api/sessions` — all session summaries (2-min cache, `?project=slug` filter)
- `GET /api/sessions/[sessionId]` — full session detail (timeline, file ops, subagents)
- `GET /api/agents` — catalog of all agents (user/plugin/project sources) joined with usage stats; `?source=user|plugin|project`, `?project=slug`, `?q=search`
- `GET /api/agents/[id]` — single agent entry with full body text + usage stats
- `GET /api/skills` — catalog of all skills with usage stats; same query params
- `GET /api/skills/[id]` — single skill entry with full body text + usage stats
- `GET/POST/DELETE /api/mcp` — Model Context Protocol server (Streamable HTTP transport, stateless). Lets Claude Desktop and Claude Code connect and query token usage, sessions, agents, skills, OTEL telemetry, manual steps, insights, git status, and portfolio stats. Server factory: `src/lib/mcp/server.ts`. Tools registered per-domain under `src/lib/mcp/tools/`; resources in `src/lib/mcp/resources.ts`. Tools call lib functions directly — no HTTP loopback. DNS-rebinding protection pinned to `localhost:4100` / `127.0.0.1:4100`. See `docs/help/mcp-server.md` for the full surface and client setup.

### UI (`src/components/`)
- Dashboard: `DashboardGrid` with search, status filter, sort options, `ProjectCard` grid
- Detail: `ProjectDetail` with tabs (Overview, Context, TODOs, Claude, Manual Steps) + `DevServerControl`
- Manual Steps: `ManualStepsDashboard` cross-project page at `/manual-steps`, `ManualStepsList` per-project checklist, `ManualStepsCompact` badge on cards
- Insights: `InsightsBrowser` at `/insights`, `InsightsTab` per-project, `InsightsCompact` badge on cards
- Stats: `StatsDashboard` at `/stats` with `StatCard`, `BarChart`, `HealthBar` sub-components
- Sessions: `SessionsBrowser` at `/sessions` lists all Claude Code sessions with one-shot rate badges. `SessionDetailView` at `/sessions/[sessionId]` with timeline, file ops, subagents tabs. Parser (`claudeConversations.ts`) reads `~/.claude/projects/` JSONL files
- Usage: `UsageDashboard` at `/usage` — token cost analytics with period filters, per-model/project/category breakdowns, daily cost chart, tool/shell/MCP stats, CSV/JSON export
- Agents: `AgentsBrowser` at `/agents` — cross-project catalog with search/filter/sort and inline expansion. `ProjectAgentsTab` per-project. Indexer at `src/lib/indexer/` (walks root, plugins, project-level agents).
- Skills: `SkillsBrowser` at `/skills` — same shape for skills. `ProjectSkillsTab` per-project. Supports bundled (`SKILL.md`-in-dir) and standalone `.md` layouts.
- `DevServerControl` — compact mode on cards (start/stop badge), full mode on detail page (start/stop/restart, open in browser, output viewer)
- Hand-rolled UI primitives in `src/components/ui/` (badge, button, input, tabs, skeleton, toast)

## Known Limitations / Technical Debt

(None currently tracked — check TODO.md for open items)

## Conventions

- Dark mode by default (html class="dark")
- CSS variables for theming (defined in `globals.css`)
- All pages are client components (`"use client"`) — data fetched via API routes
- Keyboard shortcut: `/` focuses search bar

## Git Workflow
- NEVER push directly to main. Always create a feature branch (e.g., `wave3.3`), push to that branch, and open a PR when directed.
- Do not automatically open PRs without being told to.
- Use squash-merge for PRs. Admin override is acceptable when CI passes but branch protection blocks (e.g., `gh pr merge --squash --admin`).
- After merging, verify post-merge state with typecheck and full test suite.

## Pre-existing conditions
- If you encounter a bug in a session, attempt to fix it if it is within scope of the current work.
- Create a github issue for discovered pre-existing issues, bugs, test failures, and defects that are out of scope for current work. Include details, file names and line numbers

## Verification Gates
Before committing or opening a PR, ALWAYS run: (1) `pnpm typecheck`, (2) full test suite. Report exact pass counts (e.g., '934 tests passing'). Do not mark a task complete until both pass.

## Context Management
- For long sessions, prefer `Grep` and targeted `Read` with offset/limit over re-reading whole large files.
- When observing another session's tool-output files, read incrementally and summarize early — do not accumulate full file contents in context.
- If approaching context limits, checkpoint progress to a file before continuing.

## TODO
- If I give you a TODO, save it to TODO.md in our repo.
- Consider our TODO list when planning new features. If something on the list can be accomplished during a plan or implement run, suggest it.
- Add TODO items if they make sense to do in the future, even if not part of the current plan you are creating.

## Tracking TODO.md / MANUAL_STEPS.md / INSIGHTS.md in Git

These three files all get committed. Don't stash them — `git stash pop` can silently keep the entry on conflict and a later `git stash drop` permanently deletes the changes. If you need to keep these files out of a feature commit, make a small `chore:` commit for them instead. Full rationale and per-file guidance lives on the dashboard's Setup page under "Tracking in Git."

## Documentation Policy

After completing any feature or fix, before considering the task done:
1. Identify which files changed.
2. Determine if any user-facing behavior changed or was added.
3. If yes, update the relevant section(s) in `/docs/help/`.
4. If a new UI route was added, update `lib/help-mapping.ts` (route → slug mapping).
5. Copy updated help markdown to `public/help/` (runtime-fetchable copies of `docs/help/`).
6. Commit doc changes with the feature.

## Changelog Discipline

Update `CHANGELOG.md` for any change that affects:

- UI behavior
- Application process or logic
- Validation outcomes
- API behavior or schema
- MCP behavior or schema
- Authentication/session behavior
- Subscription plans, entitlements, quotas
- Data migrations affecting interpretation

Use Keep a Changelog categories under `[Unreleased]`.

Pure refactors and test-only changes do not require entries.

## Manual Steps Logging (add this block to your CLAUDE.md)

---

### Manual Step Logging

Whenever you identify a step that I (the developer) must perform manually outside
of code — including but not limited to:

- Database migrations (Drizzle push, Prisma migrate deploy, etc.)
- External service setup (Clerk, Vercel, Stripe, Supabase, Resend, etc.)
- Environment variable configuration
- DNS or domain changes
- CLI commands that must be run in a specific environment
- Dashboard or UI actions in third-party services
- API key generation or rotation
- Deployment triggers or feature flag toggles

…you MUST append an entry to `MANUAL_STEPS.md` in the project root.

#### Format

Use this exact structure (append, never overwrite):

```
## YYYY-MM-DD HH:MM | <project-or-feature-slug> | <plain-English context title>

- [ ] First step description
  Details, commands, or URLs on indented lines beneath the step
- [ ] Second step description
  `example command --flag`
  See: https://docs.example.com/relevant-page

---
```

#### Rules

1. **Append only** — never modify or delete existing entries in MANUAL_STEPS.md.
2. **One entry per session or feature** — group related steps under a single header.
3. **Be specific** — include exact commands, environment names, and documentation links.
4. **Indented detail lines** start with two or more spaces beneath the step they belong to.
5. **Create the file** if it does not already exist.
6. After appending, **tell me** that you've logged steps to MANUAL_STEPS.md and
   summarize what was added in one or two sentences.

#### Example entry

```
## 2026-03-17 14:32 | auth | Clerk + Vercel Authentication Setup

- [ ] Install Clerk package
  `npm install @clerk/nextjs`
- [ ] Add environment variables to Vercel dashboard
  CLERK_SECRET_KEY and NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  See: https://clerk.com/docs/deployments/deploy-to-vercel
- [ ] Wrap root layout with <ClerkProvider> in app/layout.tsx
- [ ] Add middleware.ts to protect routes
  See: https://clerk.com/docs/references/nextjs/auth-middleware

---
```
