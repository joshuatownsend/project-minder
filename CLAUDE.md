# CLAUDE.md

Project: **Project Minder** — local-only dashboard that auto-scans `C:\dev\*` projects and surfaces metadata for fast context-switching.

## Stack

- **Next.js 15** (App Router) + TypeScript + React 19
- **Tailwind CSS v4** + hand-rolled shadcn-style components (no shadcn CLI)
- **No database** — filesystem is the database; user prefs in `.minder.json`
- **Dev port: 4100** — must use `--turbopack` flag (webpack dev mode hangs on Windows with this codebase)

## Commands

- `npm run dev` — starts on port 4100 with Turbopack
- `npm run build` — production build (use this to type-check)
- `npm run start` — production server on port 4100

## Architecture

### Scanner (`src/lib/scanner/`)
- `index.ts` — orchestrator: reads `C:\dev\*` dirs, runs scanner modules in parallel (batches of 10), detects port conflicts
- 7 scanner modules: `packageJson`, `envFile`, `dockerCompose`, `git`, `claudeMd`, `todoMd`, `claudeSessions`
- Claude history: reads `~/.claude/history.jsonl` using **full Windows paths** (e.g., `C:\dev\crew-leader`), parsed once and cached in a Map
- In-memory scan cache with 5-min TTL (`src/lib/cache.ts`)
- User config in `.minder.json`: project statuses + hidden project list (`src/lib/config.ts`)

### API Routes (`src/app/api/`)
- `GET /api/projects` — all scanned projects (uses cache)
- `GET /api/projects/[slug]` — single project
- `POST /api/scan` — force rescan (invalidates cache)
- `GET/PUT /api/config` — read/update statuses and hidden list

### UI (`src/components/`)
- Dashboard: `DashboardGrid` with search, status filter, sort options, `ProjectCard` grid
- Detail: `ProjectDetail` with tabs (Overview, Context, TODOs, Claude)
- Hand-rolled UI primitives in `src/components/ui/` (badge, button, input, tabs, skeleton)

## Known Limitations / Technical Debt

1. **Git dirty status disabled** — `git status --porcelain` is too slow on Windows across 61 repos. `isDirty` is hardcoded to `false`. Needs a background/lazy approach.
2. **No UI for hiding projects** — `config.hidden` is supported server-side but there's no manage/hide UI yet. 44 of 61 projects lack `package.json` and are older non-JS repos.
3. **DEV_ROOT hardcoded** — `C:\dev` is hardcoded in `src/lib/scanner/index.ts`.
4. **Unused deps** — `@radix-ui/react-dropdown-menu` and `@radix-ui/react-separator` are installed but not used yet.

## Conventions

- Dark mode by default (html class="dark")
- CSS variables for theming (defined in `globals.css`)
- All pages are client components (`"use client"`) — data fetched via API routes
- Keyboard shortcut: `/` focuses search bar
