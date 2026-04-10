# CLAUDE.md

Project: **Project Minder** — local-only dashboard that auto-scans `C:\dev\*` projects and surfaces metadata for fast context-switching.

## Stack

- **Next.js 16** (App Router) + TypeScript + React 19
- **Tailwind CSS v4** + hand-rolled shadcn-style components (no shadcn CLI)
- **No database** — filesystem is the database; user prefs in `.minder.json`
- **Dev port: 4100** — Turbopack is the default bundler in Next.js 16

## Commands

- `npm run dev` — starts on port 4100 (Turbopack is default in Next.js 16)
- `npm run build` — production build (use this to type-check)
- `npm run start` — production server on port 4100

## Architecture

### Scanner (`src/lib/scanner/`)
- `index.ts` — orchestrator: reads `C:\dev\*` dirs, runs scanner modules in parallel (batches of 10), detects port conflicts
- 9 scanner modules: `packageJson`, `envFile`, `dockerCompose`, `git`, `claudeMd`, `todoMd`, `claudeSessions`, `manualStepsMd`, `insightsMd`
- Claude history: reads `~/.claude/history.jsonl` using **full Windows paths** (e.g., `C:\dev\crew-leader`), parsed once and cached in a Map
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
- `GET /api/sessions` — all session summaries (2-min cache, `?project=slug` filter)
- `GET /api/sessions/[sessionId]` — full session detail (timeline, file ops, subagents)

### UI (`src/components/`)
- Dashboard: `DashboardGrid` with search, status filter, sort options, `ProjectCard` grid
- Detail: `ProjectDetail` with tabs (Overview, Context, TODOs, Claude, Manual Steps) + `DevServerControl`
- Manual Steps: `ManualStepsDashboard` cross-project page at `/manual-steps`, `ManualStepsList` per-project checklist, `ManualStepsCompact` badge on cards
- Insights: `InsightsBrowser` at `/insights`, `InsightsTab` per-project, `InsightsCompact` badge on cards
- Stats: `StatsDashboard` at `/stats` with `StatCard`, `BarChart`, `HealthBar` sub-components
- Sessions: `SessionsBrowser` at `/sessions` lists all Claude Code sessions. `SessionDetailView` at `/sessions/[sessionId]` with timeline, file ops, subagents tabs. Parser (`claudeConversations.ts`) reads `~/.claude/projects/` JSONL files
- `DevServerControl` — compact mode on cards (start/stop badge), full mode on detail page (start/stop/restart, open in browser, output viewer)
- Hand-rolled UI primitives in `src/components/ui/` (badge, button, input, tabs, skeleton, toast)

## Known Limitations / Technical Debt

(None currently tracked — check TODO.md for open items)

## Conventions

- Dark mode by default (html class="dark")
- CSS variables for theming (defined in `globals.css`)
- All pages are client components (`"use client"`) — data fetched via API routes
- Keyboard shortcut: `/` focuses search bar

## TODO
- If I give you a TODO, save it to TODO.md in our repo.
- Consider our TODO list when planning new features. If something on the list can be accomplished during a plan or implement run, suggest it.
- Add TODO items if they make sense to do in the future, even if not part of the current plan you are creating.

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
