# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Hide projects UI** — Three-dot menu on project cards with "Hide project" action. Confirmation dialog before hiding. "(N hidden)" link in dashboard footer opens a manage modal to view and unhide projects. Uses `@radix-ui/react-dropdown-menu`.
- **Manual Steps Tracker** — Surfaces `MANUAL_STEPS.md` entries across all projects. Interactive checkboxes toggle steps on disk. Cross-project dashboard at `/manual-steps`. File watcher with real-time toast + OS notifications when Claude adds new steps.
- **Help system** — Contextual help panel (`?` shortcut) with docs for each page/tab. Help mapping for all routes.
- **Toast notification system** — Reusable toast provider with auto-dismiss, used by manual steps notifications.

- **Configurable DEV_ROOT** — Set `devRoot` in `.minder.json` to scan a directory other than `C:\dev`. Header displays the configured path.
- **Stats Dashboard** — Portfolio-wide analytics at `/stats`. Overview cards (projects, sessions, TODOs, costs), tech stack distribution (frameworks, ORMs, styling, services), project health (status, activity recency, TODO completion), and Claude Code usage (tokens, tools, models, errors). Inspired by [Sniffly](https://github.com/chiphuyen/sniffly).
- **Sessions Browser** — Browse all Claude Code sessions at `/sessions`. Search by prompt, project, or branch. Sort by recency, duration, or tokens. Active session indicators (green pulse). Click into session detail with timeline, tool usage, file operations, and subagent tracking. Inspired by [claude-code-karma](https://github.com/JayantDevkar/claude-code-karma).

### Fixed
- **Manual Steps file corruption on rapid toggles** — Added per-file mutex to serialize read-modify-write cycles, atomic writes (write-to-temp-then-rename), and an empty-content guard that refuses to overwrite a file with blank content. Client-side: toggle requests are now queued (one in-flight at a time) with optimistic UI so checkboxes flip instantly on click. Prevents race condition where concurrent checkbox clicks or external editor access could blank the file.

### Changed
- **Upgraded to Next.js 16.2** — Turbopack is now the default bundler (removed `--turbopack` flag from dev script). Updated React to 19.2. Replaced `next lint` with direct `eslint .` command (`next lint` removed in v16).
- **Background git dirty status** — Dashboard cards now show real uncommitted change counts (amber `+N`). A background worker checks repos in batches of 3, and the dashboard polls for results. Detail pages still fetch on-demand for instant accuracy.
- Scanner now runs 8 modules (added `manualStepsMd`).
- Layout header includes "Manual Steps" nav link with pending count badge.
- Project detail page has a "Manual Steps" tab when applicable.
- Project cards show pending manual step count in amber.

### Removed
- Removed unused `@radix-ui/react-separator` dependency.
